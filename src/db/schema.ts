import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Saved connection profiles. Passwords are stored encrypted (AES-256-GCM).
 */
export const connectionProfiles = pgTable("connection_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // 'mysql' | 'postgres'
  host: text("host").notNull(),
  port: integer("port").notNull(),
  username: text("username").notNull(),
  passwordEnc: text("password_enc").notNull(),
  database: text("database").notNull(),
  schemaName: text("schema_name"),
  ssl: boolean("ssl").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per migration execution.
 */
export const migrationRuns = pgTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(), // running | completed | failed | cancelled
    sourceLabel: text("source_label").notNull(),
    targetLabel: text("target_label").notNull(),
    options: jsonb("options").notNull(),
    totalTables: integer("total_tables").notNull().default(0),
    totalRowsRead: integer("total_rows_read").notNull().default(0),
    totalRowsWritten: integer("total_rows_written").notNull().default(0),
    totalRowsFailed: integer("total_rows_failed").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("migration_runs_started_at_idx").on(table.startedAt)],
);

/**
 * Per-table outcome for a run (used for the validation report / history).
 */
export const migrationTableResults = pgTable(
  "migration_table_results",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull(),
    sourceTable: text("source_table").notNull(),
    targetTable: text("target_table").notNull(),
    status: text("status").notNull(),
    rowsRead: integer("rows_read").notNull().default(0),
    rowsWritten: integer("rows_written").notNull().default(0),
    rowsFailed: integer("rows_failed").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    message: text("message"),
  },
  (table) => [index("migration_table_results_run_idx").on(table.runId)],
);
