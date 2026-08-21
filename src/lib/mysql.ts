import mysql from "mysql2/promise";
import type { MySqlConfig, SourceColumn, SourceTable } from "./types";

export type MySqlConn = mysql.Connection;

export async function connectMySql(
  config: MySqlConfig,
  readTimestampsAsUtc = true,
): Promise<MySqlConn> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port || 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    connectTimeout: 15_000,
    charset: "utf8mb4",
  });

  if (readTimestampsAsUtc) {
    try {
      await conn.query("SET time_zone = '+00:00'");
    } catch {
      /* some managed MySQL instances forbid this; ignore */
    }
  }
  try {
    await conn.query("SET SESSION sql_mode = ''");
  } catch {
    /* ignore */
  }
  return conn;
}

export function quoteMySqlIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export async function mysqlServerInfo(conn: MySqlConn): Promise<string> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT VERSION() AS version, DATABASE() AS db",
  );
  const row = rows[0] as { version?: string; db?: string } | undefined;
  return `MySQL ${row?.version ?? "?"} · db=${row?.db ?? "?"}`;
}

/** Full introspection of every base table in the selected schema. */
export async function introspectMySql(
  conn: MySqlConn,
  database: string,
): Promise<SourceTable[]> {
  const [tableRows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_ROWS AS approxRows
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
    [database],
  );

  const [columnRows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, DATA_TYPE AS dataType,
            COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, ORDINAL_POSITION AS pos
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database],
  );

  const byTable = new Map<string, SourceColumn[]>();
  for (const raw of columnRows) {
    const r = raw as unknown as {
      tableName: string;
      name: string;
      dataType: string;
      columnType: string;
      isNullable: string;
    };
    const list = byTable.get(r.tableName) ?? [];
    list.push({
      name: r.name,
      dataType: String(r.dataType).toLowerCase(),
      columnType: String(r.columnType).toLowerCase(),
      nullable: r.isNullable === "YES",
    });
    byTable.set(r.tableName, list);
  }

  const tables: SourceTable[] = [];
  for (const raw of tableRows) {
    const r = raw as unknown as { name: string; approxRows: number | null };
    const columns = byTable.get(r.name) ?? [];
    let rows = 0;
    try {
      const [countRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM ${quoteMySqlIdent(r.name)}`,
      );
      rows = Number((countRows[0] as { c: number | string }).c ?? 0);
    } catch {
      rows = Number(r.approxRows ?? 0);
    }
    tables.push({ name: r.name, rows, columns });
  }
  return tables;
}

export async function countMySqlRows(
  conn: MySqlConn,
  table: string,
): Promise<number> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM ${quoteMySqlIdent(table)}`,
  );
  return Number((rows[0] as { c: number | string }).c ?? 0);
}

/**
 * Streams rows of a table in constant memory using mysql2's query stream.
 */
export function streamMySqlTable(
  conn: MySqlConn,
  table: string,
  columns: string[],
): AsyncIterable<Record<string, unknown>> {
  const cols = columns.map(quoteMySqlIdent).join(", ");
  const sql = `SELECT ${cols} FROM ${quoteMySqlIdent(table)}`;
  // mysql2's promise wrapper exposes the core connection for streaming.
  const core = (conn as unknown as { connection: mysql.Connection }).connection ?? conn;
  const stream = (
    core as unknown as {
      query: (sql: string) => { stream: (opts?: { highWaterMark?: number }) => AsyncIterable<Record<string, unknown>> };
    }
  )
    .query(sql)
    .stream({ highWaterMark: 200 });
  return stream;
}
