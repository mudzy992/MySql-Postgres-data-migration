import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * OPTIONAL database client.
 *
 * The migrator persists its own data (profiles, run history) in a JSON file
 * store, so no database is required to run the app. A Drizzle/PostgreSQL
 * client is still exposed when DATABASE_URL is set — it is used by the
 * engine self-test and can serve future features.
 */
const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool | null;
};

export const pool = databaseUrl
  ? (globalForDb.__arenaNextJsPostgresqlPool ??
    new Pool({
      connectionString: databaseUrl,
    }))
  : null;

if (databaseUrl && process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = pool ? drizzle(pool) : null;
