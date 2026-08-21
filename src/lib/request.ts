import type { MigrationOptions, MySqlConfig, PgConfig } from "./types";
import { DEFAULT_OPTIONS } from "./types";

type Raw = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v);

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : fallback;

export function parseMySqlConfig(raw: unknown): MySqlConfig {
  const r = (raw ?? {}) as Raw;
  return {
    host: str(r.host, "127.0.0.1").trim(),
    port: num(r.port, 3306),
    user: str(r.user).trim(),
    password: str(r.password),
    database: str(r.database).trim(),
    ssl: bool(r.ssl, false),
  };
}

export function parsePgConfig(raw: unknown): PgConfig {
  const r = (raw ?? {}) as Raw;
  return {
    host: str(r.host, "127.0.0.1").trim(),
    port: num(r.port, 5432),
    user: str(r.user).trim(),
    password: str(r.password),
    database: str(r.database).trim(),
    schema: str(r.schema, "public").trim() || "public",
    ssl: bool(r.ssl, false),
  };
}

export function parseOptions(raw: unknown): MigrationOptions {
  const r = (raw ?? {}) as Raw;
  return {
    truncateTarget: bool(r.truncateTarget, DEFAULT_OPTIONS.truncateTarget),
    disableTriggers: bool(r.disableTriggers, DEFAULT_OPTIONS.disableTriggers),
    onConflictDoNothing: bool(r.onConflictDoNothing, DEFAULT_OPTIONS.onConflictDoNothing),
    resetSequences: bool(r.resetSequences, DEFAULT_OPTIONS.resetSequences),
    continueOnError: bool(r.continueOnError, DEFAULT_OPTIONS.continueOnError),
    batchSize: Math.min(5000, num(r.batchSize, DEFAULT_OPTIONS.batchSize)),
    readTimestampsAsUtc: bool(r.readTimestampsAsUtc, DEFAULT_OPTIONS.readTimestampsAsUtc),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
