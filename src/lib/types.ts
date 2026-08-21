export type MySqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

export type PgConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema: string;
  ssl: boolean;
};

export type SourceColumn = {
  name: string;
  dataType: string; // information_schema DATA_TYPE (e.g. int, varchar, json)
  columnType: string; // e.g. tinyint(1) unsigned
  nullable: boolean;
};

export type SourceTable = {
  name: string;
  rows: number;
  columns: SourceColumn[];
};

export type TargetColumn = {
  name: string;
  udt: string; // e.g. int4, text, bool, jsonb, timestamptz
  nullable: boolean;
  hasDefault: boolean;
  isIdentity: boolean;
};

export type TargetTable = {
  name: string;
  columns: TargetColumn[];
  primaryKey: string[];
};

export type ColumnMapping = {
  source: string;
  target: string;
  udt: string;
  nullable: boolean;
};

export type TablePlan = {
  sourceTable: string;
  targetTable: string | null;
  sourceRows: number;
  targetRows: number | null;
  columns: ColumnMapping[];
  unmappedSourceColumns: string[];
  missingRequiredColumns: string[];
  status: "ready" | "partial" | "no-target" | "no-columns";
  notes: string[];
};

export type MigrationPlan = {
  tables: TablePlan[];
  order: string[]; // target table names in FK-safe order
  sourceTableCount: number;
  targetTableCount: number;
  warnings: string[];
};

export type MigrationOptions = {
  truncateTarget: boolean;
  disableTriggers: boolean;
  onConflictDoNothing: boolean;
  resetSequences: boolean;
  continueOnError: boolean;
  batchSize: number;
  readTimestampsAsUtc: boolean;
};

export const DEFAULT_OPTIONS: MigrationOptions = {
  truncateTarget: true,
  disableTriggers: true,
  onConflictDoNothing: true,
  resetSequences: true,
  continueOnError: true,
  batchSize: 500,
  readTimestampsAsUtc: true,
};

export type LogLevel = "info" | "success" | "warn" | "error";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  message: string;
};

export type TableProgress = {
  sourceTable: string;
  targetTable: string;
  totalRows: number;
  rowsRead: number;
  rowsWritten: number;
  rowsFailed: number;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  durationMs: number;
  message?: string;
};

export type JobState = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  finishedAt: number | null;
  currentTable: string | null;
  tables: TableProgress[];
  logs: LogEntry[];
  error: string | null;
  options: MigrationOptions;
  sourceLabel: string;
  targetLabel: string;
  cancelRequested: boolean;
};

export type ValidationRow = {
  table: string;
  targetTable: string;
  sourceRows: number;
  targetRows: number;
  diff: number;
  sequence: string | null;
  sequenceValue: number | null;
  maxPk: number | null;
  sequenceOk: boolean | null;
  status: "ok" | "mismatch" | "error";
  message?: string;
};
