import { NextResponse } from "next/server";
import { connectMySql, mysqlServerInfo } from "@/lib/mysql";
import { connectPg, introspectPg, pgServerInfo } from "@/lib/pg";
import { errorMessage, parseMySqlConfig, parsePgConfig } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    kind?: string;
    config?: unknown;
  };

  try {
    if (body.kind === "mysql") {
      const config = parseMySqlConfig(body.config);
      if (!config.database || !config.user) {
        return NextResponse.json(
          { ok: false, error: "MySQL user and database are required." },
          { status: 400 },
        );
      }
      const conn = await connectMySql(config);
      const info = await mysqlServerInfo(conn);
      const [rows] = await conn.query(
        "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
        [config.database],
      );
      const tableCount = Number(
        (rows as Array<{ c: number | string }>)[0]?.c ?? 0,
      );
      await conn.end();
      return NextResponse.json({ ok: true, info, tableCount });
    }

    const config = parsePgConfig(body.config);
    if (!config.database || !config.user) {
      return NextResponse.json(
        { ok: false, error: "PostgreSQL user and database are required." },
        { status: 400 },
      );
    }
    const client = await connectPg(config);
    const info = await pgServerInfo(client);
    const tables = await introspectPg(client, config.schema);
    await client.end();
    return NextResponse.json({
      ok: true,
      info: `${info} · schema=${config.schema}`,
      tableCount: tables.length,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: errorMessage(error) },
      { status: 200 },
    );
  }
}
