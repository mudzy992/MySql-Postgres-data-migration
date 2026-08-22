import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Tiny file-backed store for connection profiles and migration history.
 * The migrator itself connects directly to the user's MySQL/PostgreSQL
 * servers, so no database service is required — this JSON file is all the
 * persistence the app needs.
 *
 * Location is configurable via STORE_PATH (mounted as a volume in Docker).
 */

export type StoredProfile = {
  id: number;
  name: string;
  kind: string; // 'mysql' | 'postgres'
  host: string;
  port: number;
  user: string;
  passwordEnc: string;
  database: string;
  schemaName: string | null;
  ssl: boolean;
  createdAt: string;
};

export type StoredRun = {
  id: string;
  status: string; // running | completed | failed | cancelled
  sourceLabel: string;
  targetLabel: string;
  options: unknown;
  totalTables: number;
  totalRowsRead: number;
  totalRowsWritten: number;
  totalRowsFailed: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type StoredTableResult = {
  runId: string;
  sourceTable: string;
  targetTable: string;
  status: string;
  rowsRead: number;
  rowsWritten: number;
  rowsFailed: number;
  durationMs: number;
  message: string | null;
};

type StoreShape = {
  profiles: StoredProfile[];
  runs: StoredRun[];
  tableResults: StoredTableResult[];
};

const STORE_PATH =
  process.env.STORE_PATH ?? path.join(process.cwd(), ".migrator-store.json");

const EMPTY: StoreShape = { profiles: [], runs: [], tableResults: [] };

let cache: StoreShape | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<StoreShape> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    cache = {
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      tableResults: Array.isArray(parsed.tableResults) ? parsed.tableResults : [],
    };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

/** Serialized atomic writes: write tmp file, then rename over the real one. */
async function persist(store: StoreShape): Promise<void> {
  cache = store;
  writeQueue = writeQueue
    .then(async () => {
      const dir = path.dirname(STORE_PATH);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${STORE_PATH}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
      await fs.rename(tmp, STORE_PATH);
    })
    .catch(() => {
      /* persistence is best-effort */
    });
  return writeQueue;
}

export async function storeInfo(): Promise<{
  path: string;
  profiles: number;
  runs: number;
}> {
  const store = await load();
  return {
    path: STORE_PATH,
    profiles: store.profiles.length,
    runs: store.runs.length,
  };
}

/* --------------------------------------------------------- profiles ----- */

export async function listProfiles(): Promise<StoredProfile[]> {
  const store = await load();
  return [...store.profiles].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addProfile(
  profile: Omit<StoredProfile, "id" | "createdAt">,
): Promise<StoredProfile> {
  const store = await load();
  const nextId = store.profiles.reduce((max, p) => Math.max(max, p.id), 0) + 1;
  const record: StoredProfile = {
    ...profile,
    id: nextId,
    createdAt: new Date().toISOString(),
  };
  await persist({ ...store, profiles: [...store.profiles, record] });
  return record;
}

export async function deleteProfile(id: number): Promise<void> {
  const store = await load();
  await persist({
    ...store,
    profiles: store.profiles.filter((p) => p.id !== id),
  });
}

/* -------------------------------------------------------------- runs ---- */

const MAX_RUNS = 50;

export async function listRuns(limit = 10): Promise<StoredRun[]> {
  const store = await load();
  return [...store.runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export async function addRun(
  run: Omit<StoredRun, "startedAt" | "finishedAt"> & Partial<StoredRun>,
): Promise<void> {
  const store = await load();
  const record: StoredRun = {
    finishedAt: null,
    ...run,
    startedAt: run.startedAt ?? new Date().toISOString(),
  };
  await persist({
    ...store,
    runs: [...store.runs, record].slice(-MAX_RUNS),
    tableResults: store.tableResults.filter((r) =>
      store.runs.concat(record).slice(-MAX_RUNS).some((x) => x.id === r.runId),
    ),
  });
}

export async function updateRun(
  id: string,
  patch: Partial<StoredRun>,
): Promise<void> {
  const store = await load();
  await persist({
    ...store,
    runs: store.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)),
  });
}

export async function addTableResult(result: StoredTableResult): Promise<void> {
  const store = await load();
  await persist({
    ...store,
    tableResults: [...store.tableResults, result],
  });
}
