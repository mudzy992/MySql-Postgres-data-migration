import { NextResponse } from "next/server";
import { connectMySql, countMySqlRows } from "@/lib/mysql";
import { connectPg, countPgRows, currentSequenceValue, introspectPg } from "@/lib/pg";
import { errorMessage, parseMySqlConfig, parsePgConfig } from "@/lib/request";
import type { TablePlan, ValidationRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    mysql?: unknown;
    postgres?: unknown;
    tables?: TablePlan[];
  };
  const mysqlConfig = parseMySqlConfig(body.mysql);
  const pgConfig = parsePgConfig(body.postgres);
  const plans = (body.tables ?? []).filter((t) => t && t.targetTable);

  let conn: Awaited<ReturnType<typeof connectMySql>> | null = null;
  let client: Awaited<ReturnType<typeof connectPg>> | null = null;

  try {
    conn = await connectMySql(mysqlConfig);
    client = await connectPg(pgConfig);
    const targetTables = await introspectPg(client, pgConfig.schema);
    const pkByTable = new Map(targetTables.map((t) => [t.name, t.primaryKey]));

    const rows: ValidationRow[] = [];
    for (const plan of plans) {
      const targetTable = plan.targetTable as string;
      try {
        const sourceRows = await countMySqlRows(conn, plan.sourceTable);
        const targetRows = await countPgRows(client, pgConfig.schema, targetTable);

        let sequence: string | null = null;
        let sequenceValue: number | null = null;
        let maxPk: number | null = null;
        let sequenceOk: boolean | null = null;

        const pk = pkByTable.get(targetTable) ?? [];
        if (pk.length === 1) {
          try {
            const seq = await currentSequenceValue(
              client,
              pgConfig.schema,
              targetTable,
              pk[0] as string,
            );
            if (seq) {
              sequence = seq.sequence;
              sequenceValue = seq.value;
              maxPk = seq.maxPk;
              sequenceOk = seq.maxPk === null ? true : seq.value > seq.maxPk;
            }
          } catch {
            /* not a serial pk */
          }
        }

        rows.push({
          table: plan.sourceTable,
          targetTable,
          sourceRows,
          targetRows,
          diff: targetRows - sourceRows,
          sequence,
          sequenceValue,
          maxPk,
          sequenceOk,
          status:
            targetRows === sourceRows && sequenceOk !== false ? "ok" : "mismatch",
        });
      } catch (error) {
        rows.push({
          table: plan.sourceTable,
          targetTable,
          sourceRows: 0,
          targetRows: 0,
          diff: 0,
          sequence: null,
          sequenceValue: null,
          maxPk: null,
          sequenceOk: null,
          status: "error",
          message: errorMessage(error),
        });
      }
    }

    const summary = {
      tables: rows.length,
      ok: rows.filter((r) => r.status === "ok").length,
      mismatch: rows.filter((r) => r.status === "mismatch").length,
      errors: rows.filter((r) => r.status === "error").length,
      sourceRows: rows.reduce((a, r) => a + r.sourceRows, 0),
      targetRows: rows.reduce((a, r) => a + r.targetRows, 0),
    };

    return NextResponse.json({ ok: true, rows, summary });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 200 });
  } finally {
    try {
      await conn?.end();
    } catch {
      /* ignore */
    }
    try {
      await client?.end();
    } catch {
      /* ignore */
    }
  }
}
