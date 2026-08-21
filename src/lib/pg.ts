import { Client } from "pg";
import type { PgConfig, TargetColumn, TargetTable } from "./types";

export async function connectPg(config: PgConfig): Promise<Client> {
  const client = new Client({
    host: config.host,
    port: config.port || 5432,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 0,
  });
  await client.connect();
  if (config.schema && config.schema !== "public") {
    await client.query(`SET search_path TO ${quoteIdent(config.schema)}, public`);
  }
  return client;
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export async function pgServerInfo(client: Client): Promise<string> {
  const res = await client.query<{ version: string; db: string }>(
    "SELECT version() AS version, current_database() AS db",
  );
  const version = res.rows[0]?.version?.split(" ").slice(0, 2).join(" ") ?? "PostgreSQL";
  return `${version} · db=${res.rows[0]?.db ?? "?"}`;
}

export async function introspectPg(
  client: Client,
  schema: string,
): Promise<TargetTable[]> {
  const tablesRes = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`,
    [schema],
  );

  const colsRes = await client.query<{
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    is_identity: string;
  }>(
    `SELECT table_name, column_name, udt_name, is_nullable, column_default, is_identity
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schema],
  );

  const pkRes = await client.query<{ table_name: string; column_name: string }>(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [schema],
  );

  const colMap = new Map<string, TargetColumn[]>();
  for (const r of colsRes.rows) {
    const list = colMap.get(r.table_name) ?? [];
    list.push({
      name: r.column_name,
      udt: r.udt_name,
      nullable: r.is_nullable === "YES",
      hasDefault: r.column_default !== null || r.is_identity === "YES",
      isIdentity: r.is_identity === "YES" || (r.column_default ?? "").includes("nextval("),
    });
    colMap.set(r.table_name, list);
  }

  const pkMap = new Map<string, string[]>();
  for (const r of pkRes.rows) {
    const list = pkMap.get(r.table_name) ?? [];
    list.push(r.column_name);
    pkMap.set(r.table_name, list);
  }

  return tablesRes.rows.map((t) => ({
    name: t.table_name,
    columns: colMap.get(t.table_name) ?? [],
    primaryKey: pkMap.get(t.table_name) ?? [],
  }));
}

/** child -> parents (foreign key dependencies) inside one schema. */
export async function fkDependencies(
  client: Client,
  schema: string,
): Promise<Map<string, Set<string>>> {
  const res = await client.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child_full,
            c.confrelid::regclass::text AS parent_full,
            child.relname AS child,
            parent.relname AS parent
       FROM pg_constraint c
       JOIN pg_class child ON child.oid = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE c.contype = 'f' AND n.nspname = $1`,
    [schema],
  );
  const map = new Map<string, Set<string>>();
  for (const r of res.rows) {
    const set = map.get(r.child) ?? new Set<string>();
    if (r.parent !== r.child) set.add(r.parent);
    map.set(r.child, set);
  }
  return map;
}

/** Kahn topological sort: parents before children. Cycles are appended at the end. */
export function topoSort(tables: string[], deps: Map<string, Set<string>>): string[] {
  const present = new Set(tables);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tables) indegree.set(t, 0);
  for (const t of tables) {
    const parents = deps.get(t);
    if (!parents) continue;
    for (const p of parents) {
      if (!present.has(p)) continue;
      indegree.set(t, (indegree.get(t) ?? 0) + 1);
      dependents.set(p, [...(dependents.get(p) ?? []), t]);
    }
  }

  const queue = tables.filter((t) => (indegree.get(t) ?? 0) === 0).sort();
  const out: string[] = [];
  while (queue.length) {
    const t = queue.shift() as string;
    out.push(t);
    for (const child of dependents.get(t) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  for (const t of tables) if (!out.includes(t)) out.push(t);
  return out;
}

export async function countPgRows(
  client: Client,
  schema: string,
  table: string,
): Promise<number> {
  const res = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ${qualified(schema, table)}`,
  );
  return Number(res.rows[0]?.c ?? 0);
}

export async function resetSequence(
  client: Client,
  schema: string,
  table: string,
  column: string,
): Promise<{ sequence: string; value: number } | null> {
  // pg_get_serial_sequence() parses its first argument as an SQL name, so the
  // identifier must be quoted or Prisma's PascalCase tables get lowercased.
  const seqRes = await client.query<{ seq: string | null }>(
    `SELECT pg_get_serial_sequence($1, $2) AS seq`,
    [qualified(schema, table), column],
  );
  const seq = seqRes.rows[0]?.seq;
  if (!seq) return null;
  const res = await client.query<{ v: string }>(
    `SELECT setval($1, COALESCE((SELECT MAX(${quoteIdent(column)}) FROM ${qualified(
      schema,
      table,
    )}), 0) + 1, false)::text AS v`,
    [seq],
  );
  return { sequence: seq, value: Number(res.rows[0]?.v ?? 0) };
}

export async function currentSequenceValue(
  client: Client,
  schema: string,
  table: string,
  column: string,
): Promise<{ sequence: string; value: number; maxPk: number | null } | null> {
  const seqRes = await client.query<{ seq: string | null }>(
    `SELECT pg_get_serial_sequence($1, $2) AS seq`,
    [qualified(schema, table), column],
  );
  const seq = seqRes.rows[0]?.seq;
  if (!seq) return null;
  const res = await client.query<{ last: string | null; maxpk: string | null }>(
    `SELECT (SELECT last_value::text FROM ${seq}) AS last,
            (SELECT MAX(${quoteIdent(column)})::text FROM ${qualified(schema, table)}) AS maxpk`,
  );
  return {
    sequence: seq,
    value: Number(res.rows[0]?.last ?? 0),
    maxPk: res.rows[0]?.maxpk === null ? null : Number(res.rows[0]?.maxpk),
  };
}
