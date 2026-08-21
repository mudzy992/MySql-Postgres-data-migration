import type { Client } from "pg";
import { db } from "@/db";
import { migrationRuns, migrationTableResults } from "@/db/schema";
import { eq } from "drizzle-orm";
import { connectMySql, streamMySqlTable, countMySqlRows } from "./mysql";
import { connectPg, qualified, quoteIdent, resetSequence } from "./pg";
import { coerceValue } from "./plan";
import { log, updateTable } from "./jobs";
import type {
  JobState,
  MigrationOptions,
  MySqlConfig,
  PgConfig,
  TablePlan,
} from "./types";

const PG_MAX_PARAMS = 60_000;

export function buildInsert(
  schema: string,
  table: string,
  columns: string[],
  rowCount: number,
  onConflictDoNothing: boolean,
): string {
  const colList = columns.map(quoteIdent).join(", ");
  const tuples: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const placeholders: string[] = [];
    for (let c = 0; c < columns.length; c++) placeholders.push(`$${p++}`);
    tuples.push(`(${placeholders.join(", ")})`);
  }
  return `INSERT INTO ${qualified(schema, table)} (${colList}) VALUES ${tuples.join(
    ", ",
  )}${onConflictDoNothing ? " ON CONFLICT DO NOTHING" : ""}`;
}

async function insertBatch(
  client: Client,
  schema: string,
  plan: TablePlan,
  rows: unknown[][],
  options: MigrationOptions,
): Promise<{ written: number; failed: number; error?: string }> {
  if (rows.length === 0) return { written: 0, failed: 0 };
  const targetCols = plan.columns.map((c) => c.target);
  const sql = buildInsert(
    schema,
    plan.targetTable as string,
    targetCols,
    rows.length,
    options.onConflictDoNothing,
  );
  const params = rows.flat();
  try {
    const res = await client.query(sql, params);
    return { written: res.rowCount ?? rows.length, failed: 0 };
  } catch (batchError) {
    if (!options.continueOnError || rows.length === 1) {
      return {
        written: 0,
        failed: rows.length,
        error: (batchError as Error).message,
      };
    }
    // Retry row-by-row so a single bad record does not kill the whole batch.
    let written = 0;
    let failed = 0;
    let firstError: string | undefined;
    for (const row of rows) {
      const singleSql = buildInsert(
        schema,
        plan.targetTable as string,
        targetCols,
        1,
        options.onConflictDoNothing,
      );
      try {
        const res = await client.query(singleSql, row);
        written += res.rowCount ?? 1;
      } catch (rowError) {
        failed += 1;
        firstError ??= (rowError as Error).message;
      }
    }
    return { written, failed, error: firstError };
  }
}

export async function runMigration(
  job: JobState,
  mysqlConfig: MySqlConfig,
  pgConfig: PgConfig,
  plans: TablePlan[],
  options: MigrationOptions,
): Promise<void> {
  let mysqlConn: Awaited<ReturnType<typeof connectMySql>> | null = null;
  let pgClient: Client | null = null;
  let triggersDisabled = false;

  try {
    await db.insert(migrationRuns).values({
      id: job.id,
      status: "running",
      sourceLabel: job.sourceLabel,
      targetLabel: job.targetLabel,
      options,
      totalTables: plans.length,
    });
  } catch {
    /* history is best-effort */
  }

  try {
    log(job, "info", `Connecting to MySQL at ${mysqlConfig.host}:${mysqlConfig.port}…`);
    mysqlConn = await connectMySql(mysqlConfig, options.readTimestampsAsUtc);
    log(job, "success", "MySQL connection established.");

    log(job, "info", `Connecting to PostgreSQL at ${pgConfig.host}:${pgConfig.port}…`);
    pgClient = await connectPg(pgConfig);
    log(job, "success", "PostgreSQL connection established.");

    if (options.disableTriggers) {
      try {
        await pgClient.query("SET session_replication_role = 'replica'");
        triggersDisabled = true;
        log(job, "info", "Foreign key triggers disabled for this session.");
      } catch {
        log(
          job,
          "warn",
          "Could not disable FK triggers (needs superuser). Relying on dependency ordering instead.",
        );
      }
    }

    if (options.truncateTarget) {
      const targets = plans
        .filter((p) => p.targetTable)
        .map((p) => qualified(pgConfig.schema, p.targetTable as string));
      if (targets.length) {
        try {
          await pgClient.query(
            `TRUNCATE TABLE ${targets.join(", ")} RESTART IDENTITY CASCADE`,
          );
          log(job, "warn", `Truncated ${targets.length} target table(s) (CASCADE).`);
        } catch (error) {
          log(
            job,
            "warn",
            `TRUNCATE failed (${(error as Error).message}). Falling back to DELETE.`,
          );
          for (const t of targets) {
            try {
              await pgClient.query(`DELETE FROM ${t}`);
            } catch (delError) {
              log(job, "error", `DELETE ${t} failed: ${(delError as Error).message}`);
            }
          }
        }
      }
    }

    for (const plan of plans) {
      if (job.cancelRequested) {
        job.status = "cancelled";
        log(job, "warn", "Migration cancelled by user.");
        break;
      }
      if (!plan.targetTable || plan.columns.length === 0) {
        updateTable(job, plan.sourceTable, {
          status: "skipped",
          message: "No target table / no mapped columns",
        });
        log(job, "warn", `Skipping \`${plan.sourceTable}\` — nothing to map.`);
        continue;
      }

      const started = Date.now();
      job.currentTable = plan.sourceTable;
      updateTable(job, plan.sourceTable, { status: "running" });
      log(
        job,
        "info",
        `→ ${plan.sourceTable} → "${plan.targetTable}" (${plan.columns.length} columns)`,
      );

      let total = plan.sourceRows;
      try {
        total = await countMySqlRows(mysqlConn, plan.sourceTable);
        updateTable(job, plan.sourceTable, { totalRows: total });
      } catch {
        /* keep estimate */
      }

      const maxRows = Math.max(
        1,
        Math.min(
          options.batchSize,
          Math.floor(PG_MAX_PARAMS / Math.max(1, plan.columns.length)),
        ),
      );

      let read = 0;
      let written = 0;
      let failed = 0;
      let batch: unknown[][] = [];
      let tableError: string | undefined;

      const flush = async () => {
        if (!pgClient || batch.length === 0) return;
        const result = await insertBatch(pgClient, pgConfig.schema, plan, batch, options);
        written += result.written;
        failed += result.failed;
        if (result.error) {
          tableError ??= result.error;
          log(
            job,
            failed > 0 ? "error" : "warn",
            `${plan.sourceTable}: ${result.error}`,
          );
        }
        batch = [];
        updateTable(job, plan.sourceTable, {
          rowsRead: read,
          rowsWritten: written,
          rowsFailed: failed,
        });
      };

      try {
        const stream = streamMySqlTable(
          mysqlConn,
          plan.sourceTable,
          plan.columns.map((c) => c.source),
        );
        for await (const row of stream) {
          read += 1;
          batch.push(
            plan.columns.map((c) =>
              coerceValue(
                (row as Record<string, unknown>)[c.source],
                c.udt,
                c.nullable,
                options.readTimestampsAsUtc,
              ),
            ),
          );
          if (batch.length >= maxRows) {
            await flush();
            if (job.cancelRequested) break;
          }
        }
        await flush();

        if (options.resetSequences) {
          for (const col of plan.columns) {
            if (!/^int|^serial|^big/.test(col.udt)) continue;
            try {
              const seq = await resetSequence(
                pgClient,
                pgConfig.schema,
                plan.targetTable,
                col.target,
              );
              if (seq) {
                log(
                  job,
                  "info",
                  `Sequence ${seq.sequence} reset to ${seq.value} for "${plan.targetTable}"."${col.target}".`,
                );
              }
            } catch {
              /* not a serial column */
            }
          }
        }

        const durationMs = Date.now() - started;
        const status = failed > 0 ? "failed" : "done";
        updateTable(job, plan.sourceTable, {
          status,
          rowsRead: read,
          rowsWritten: written,
          rowsFailed: failed,
          durationMs,
          message: tableError,
        });
        log(
          job,
          failed > 0 ? "warn" : "success",
          `✓ ${plan.sourceTable}: read ${read}, inserted ${written}${
            failed ? `, failed ${failed}` : ""
          } (${durationMs} ms)`,
        );

        try {
          await db.insert(migrationTableResults).values({
            runId: job.id,
            sourceTable: plan.sourceTable,
            targetTable: plan.targetTable,
            status,
            rowsRead: read,
            rowsWritten: written,
            rowsFailed: failed,
            durationMs,
            message: tableError ?? null,
          });
        } catch {
          /* history is best-effort */
        }
      } catch (error) {
        const message = (error as Error).message;
        updateTable(job, plan.sourceTable, {
          status: "failed",
          rowsRead: read,
          rowsWritten: written,
          rowsFailed: failed,
          durationMs: Date.now() - started,
          message,
        });
        log(job, "error", `✗ ${plan.sourceTable}: ${message}`);
        if (!options.continueOnError) throw error;
      }
    }

    job.currentTable = null;
    if (job.status === "running") {
      const anyFailed = job.tables.some((t) => t.status === "failed");
      job.status = anyFailed ? "failed" : "completed";
      log(
        job,
        anyFailed ? "warn" : "success",
        anyFailed
          ? "Migration finished with errors — check the table report."
          : "Migration completed successfully. Run validation next.",
      );
    }
  } catch (error) {
    job.status = "failed";
    job.error = (error as Error).message;
    log(job, "error", `Fatal: ${job.error}`);
  } finally {
    if (pgClient && triggersDisabled) {
      try {
        await pgClient.query("SET session_replication_role = 'origin'");
      } catch {
        /* ignore */
      }
    }
    try {
      await pgClient?.end();
    } catch {
      /* ignore */
    }
    try {
      await mysqlConn?.end();
    } catch {
      /* ignore */
    }
    job.finishedAt = Date.now();

    const totals = job.tables.reduce(
      (acc, t) => ({
        read: acc.read + t.rowsRead,
        written: acc.written + t.rowsWritten,
        failed: acc.failed + t.rowsFailed,
      }),
      { read: 0, written: 0, failed: 0 },
    );
    try {
      await db
        .update(migrationRuns)
        .set({
          status: job.status,
          totalRowsRead: totals.read,
          totalRowsWritten: totals.written,
          totalRowsFailed: totals.failed,
          errorMessage: job.error,
          finishedAt: new Date(),
        })
        .where(eq(migrationRuns.id, job.id));
    } catch {
      /* history is best-effort */
    }
  }
}
