import type { JobState, LogLevel, TableProgress } from "./types";

const globalForJobs = globalThis as typeof globalThis & {
  __migrationJobs?: Map<string, JobState>;
};

const jobs: Map<string, JobState> =
  globalForJobs.__migrationJobs ?? new Map<string, JobState>();
globalForJobs.__migrationJobs = jobs;

export function createJob(state: Omit<JobState, "logs" | "cancelRequested">): JobState {
  const job: JobState = { ...state, logs: [], cancelRequested: false };
  jobs.set(job.id, job);
  // Keep only the 25 most recent jobs in memory.
  if (jobs.size > 25) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  return job;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

export function listJobs(): JobState[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function log(job: JobState, level: LogLevel, message: string): void {
  job.logs.push({ ts: Date.now(), level, message });
  if (job.logs.length > 800) job.logs.splice(0, job.logs.length - 800);
}

export function updateTable(
  job: JobState,
  sourceTable: string,
  patch: Partial<TableProgress>,
): void {
  const t = job.tables.find((x) => x.sourceTable === sourceTable);
  if (t) Object.assign(t, patch);
}

export function requestCancel(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  log(job, "warn", "Cancellation requested — finishing current batch…");
  return true;
}
