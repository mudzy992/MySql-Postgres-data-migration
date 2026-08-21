import { NextResponse } from "next/server";
import { connectMySql, introspectMySql } from "@/lib/mysql";
import { connectPg, countPgRows, fkDependencies, introspectPg, topoSort } from "@/lib/pg";
import { buildPlan } from "@/lib/plan";
import { errorMessage, parseMySqlConfig, parsePgConfig } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    mysql?: unknown;
    postgres?: unknown;
  };
  const mysqlConfig = parseMySqlConfig(body.mysql);
  const pgConfig = parsePgConfig(body.postgres);

  let conn: Awaited<ReturnType<typeof connectMySql>> | null = null;
  let client: Awaited<ReturnType<typeof connectPg>> | null = null;

  try {
    conn = await connectMySql(mysqlConfig);
    const sourceTables = await introspectMySql(conn, mysqlConfig.database);

    client = await connectPg(pgConfig);
    const targetTables = await introspectPg(client, pgConfig.schema);
    const deps = await fkDependencies(client, pgConfig.schema);
    const order = topoSort(
      targetTables.map((t) => t.name),
      deps,
    );

    const plan = buildPlan(sourceTables, targetTables, order);

    // Current row counts in the target so the user sees what will be overwritten.
    for (const t of plan.tables) {
      if (!t.targetTable) continue;
      try {
        t.targetRows = await countPgRows(client, pgConfig.schema, t.targetTable);
      } catch {
        t.targetRows = null;
      }
    }

    return NextResponse.json({ ok: true, plan });
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
