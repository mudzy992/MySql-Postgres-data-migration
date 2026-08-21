"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionForm, type ConnForm, type Profile } from "./ConnectionForm";
import { Badge, Button, Card, Progress, Spinner, Toggle } from "./ui";
import type {
  LogEntry,
  MigrationOptions,
  MigrationPlan,
  TablePlan,
  TableProgress,
  ValidationRow,
} from "@/lib/types";
import { DEFAULT_OPTIONS } from "@/lib/types";

type JobSnapshot = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  currentTable: string | null;
  tables: TableProgress[];
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  logCursor: number;
  logs: LogEntry[];
};

type RunRow = {
  id: string;
  status: string;
  sourceLabel: string;
  targetLabel: string;
  totalTables: number;
  totalRowsWritten: number;
  totalRowsFailed: number;
  startedAt: string;
};

const STEPS = ["Connect", "Analyze & select", "Migrate", "Validate"] as const;

const MYSQL_DEFAULT: ConnForm = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "",
  ssl: false,
};

const PG_DEFAULT: ConnForm = {
  host: "127.0.0.1",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "app_db",
  schema: "public",
  ssl: false,
};

const nf = new Intl.NumberFormat("en-US");

export default function MigratorApp() {
  const [step, setStep] = useState(0);
  const [mysqlCfg, setMysqlCfg] = useState<ConnForm>(MYSQL_DEFAULT);
  const [pgCfg, setPgCfg] = useState<ConnForm>(PG_DEFAULT);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<MigrationOptions>(DEFAULT_OPTIONS);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [starting, setStarting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    rows: ValidationRow[];
    summary: {
      tables: number;
      ok: number;
      mismatch: number;
      errors: number;
      sourceRows: number;
      targetRows: number;
    };
  } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selftest, setSelftest] = useState<{
    ok: boolean;
    steps: { name: string; ok: boolean; detail: string }[];
    error?: string;
  } | null>(null);
  const [selftesting, setSelftesting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(0);

  /* ---------------------------------------------------------------- setup */

  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/profiles");
      const data = (await res.json()) as { profiles?: Profile[] };
      setProfiles(data.profiles ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      const data = (await res.json()) as { runs?: RunRow[] };
      setRuns(data.runs ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
    void loadRuns();
    try {
      const saved = localStorage.getItem("migrator.conns");
      if (saved) {
        const parsed = JSON.parse(saved) as { mysql?: ConnForm; postgres?: ConnForm };
        if (parsed.mysql) setMysqlCfg({ ...MYSQL_DEFAULT, ...parsed.mysql, password: "" });
        if (parsed.postgres)
          setPgCfg({ ...PG_DEFAULT, ...parsed.postgres, password: "" });
      }
    } catch {
      /* ignore */
    }
  }, [loadProfiles, loadRuns]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "migrator.conns",
        JSON.stringify({
          mysql: { ...mysqlCfg, password: "" },
          postgres: { ...pgCfg, password: "" },
        }),
      );
    } catch {
      /* ignore */
    }
  }, [mysqlCfg, pgCfg]);

  /* -------------------------------------------------------------- polling */

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/migrate/status?id=${jobId}&since=${cursorRef.current}`,
        );
        const data = (await res.json()) as { ok: boolean; job?: JobSnapshot };
        if (!active) return;
        if (data.ok && data.job) {
          setJob(data.job);
          if (data.job.logs.length) {
            setLogs((prev) => [...prev, ...data.job!.logs].slice(-600));
            cursorRef.current = data.job.logCursor;
          }
          if (data.job.status !== "running") {
            void loadRuns();
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      if (active) timer = setTimeout(() => void tick(), 700);
    };

    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, loadRuns]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  /* --------------------------------------------------------------- actions */

  const saveProfile = async (kind: "mysql" | "postgres", name: string) => {
    await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name, config: kind === "mysql" ? mysqlCfg : pgCfg }),
    });
    await loadProfiles();
  };

  const deleteProfile = async (id: number) => {
    await fetch(`/api/profiles?id=${id}`, { method: "DELETE" });
    await loadProfiles();
  };

  const runSelfTest = async () => {
    setSelftesting(true);
    setSelftest(null);
    try {
      const res = await fetch("/api/selftest", { method: "POST" });
      setSelftest((await res.json()) as NonNullable<typeof selftest>);
    } catch (error) {
      setSelftest({ ok: false, steps: [], error: (error as Error).message });
    } finally {
      setSelftesting(false);
    }
  };

  const analyze = async () => {
    setAnalyzing(true);
    setPlanError(null);
    try {
      const res = await fetch("/api/introspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mysql: mysqlCfg, postgres: pgCfg }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        plan?: MigrationPlan;
        error?: string;
      };
      if (!data.ok || !data.plan) {
        setPlanError(data.error ?? "Introspection failed.");
        return;
      }
      setPlan(data.plan);
      setSelected(
        new Set(
          data.plan.tables
            .filter((t) => t.targetTable && t.columns.length > 0)
            .map((t) => t.sourceTable),
        ),
      );
      setStep(1);
    } catch (error) {
      setPlanError((error as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const selectedPlans: TablePlan[] = useMemo(
    () => (plan?.tables ?? []).filter((t) => selected.has(t.sourceTable)),
    [plan, selected],
  );

  const startMigration = async () => {
    setStarting(true);
    setLogs([]);
    setJob(null);
    setValidation(null);
    cursorRef.current = 0;
    try {
      const res = await fetch("/api/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mysql: mysqlCfg,
          postgres: pgCfg,
          options,
          tables: selectedPlans,
        }),
      });
      const data = (await res.json()) as { ok: boolean; jobId?: string; error?: string };
      if (data.ok && data.jobId) {
        setJobId(data.jobId);
        setStep(2);
      } else {
        setLogs([
          { ts: Date.now(), level: "error", message: data.error ?? "Could not start." },
        ]);
      }
    } finally {
      setStarting(false);
    }
  };

  const cancelMigration = async () => {
    if (!jobId) return;
    await fetch(`/api/migrate?id=${jobId}`, { method: "DELETE" });
  };

  const runValidation = async () => {
    setValidating(true);
    setValidationError(null);
    try {
      const res = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mysql: mysqlCfg,
          postgres: pgCfg,
          tables: selectedPlans.length ? selectedPlans : (plan?.tables ?? []),
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        rows?: ValidationRow[];
        summary?: NonNullable<typeof validation>["summary"];
        error?: string;
      };
      if (!data.ok || !data.rows || !data.summary) {
        setValidationError(data.error ?? "Validation failed.");
        return;
      }
      setValidation({ rows: data.rows, summary: data.summary });
    } catch (error) {
      setValidationError((error as Error).message);
    } finally {
      setValidating(false);
    }
  };

  /* ---------------------------------------------------------------- render */

  const visibleTables = (plan?.tables ?? []).filter((t) =>
    search.trim()
      ? `${t.sourceTable} ${t.targetTable ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      : true,
  );

  const totals = useMemo(() => {
    const rows = selectedPlans.reduce((a, t) => a + t.sourceRows, 0);
    return { tables: selectedPlans.length, rows };
  }, [selectedPlans]);

  const jobTotals = useMemo(() => {
    const t = job?.tables ?? [];
    return {
      read: t.reduce((a, x) => a + x.rowsRead, 0),
      written: t.reduce((a, x) => a + x.rowsWritten, 0),
      failed: t.reduce((a, x) => a + x.rowsFailed, 0),
      total: t.reduce((a, x) => a + x.totalRows, 0),
      done: t.filter((x) => x.status === "done" || x.status === "failed" || x.status === "skipped").length,
    };
  }, [job]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">
              Data migration console
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              MySQL <span className="text-slate-600">→</span> PostgreSQL
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              Prisma already built your PostgreSQL schema — this tool only moves the{" "}
              <strong className="text-slate-200">data</strong>. It maps tables and columns
              automatically (snake_case ↔ PascalCase), copies rows in FK-safe order,
              re-syncs identity sequences and verifies the result.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            engine ready · read-only on source
          </div>
        </div>

        <nav className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STEPS.map((label, i) => {
            const state = i === step ? "current" : i < step ? "done" : "todo";
            return (
              <button
                key={label}
                type="button"
                onClick={() => setStep(i)}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                  state === "current"
                    ? "border-sky-500/50 bg-sky-500/10"
                    : state === "done"
                      ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/60"
                      : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    state === "current"
                      ? "bg-sky-500 text-white"
                      : state === "done"
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-slate-800 text-slate-500"
                  }`}
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span
                  className={`text-sm font-medium ${
                    state === "todo" ? "text-slate-500" : "text-slate-100"
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* ---------------------------------------------------------- step 1 */}
      {step === 0 ? (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <ConnectionForm
              kind="mysql"
              value={mysqlCfg}
              onChange={setMysqlCfg}
              profiles={profiles}
              onSaveProfile={(name) => saveProfile("mysql", name)}
              onDeleteProfile={deleteProfile}
              accent="bg-amber-500/15"
            />
            <ConnectionForm
              kind="postgres"
              value={pgCfg}
              onChange={setPgCfg}
              profiles={profiles}
              onSaveProfile={(name) => saveProfile("postgres", name)}
              onDeleteProfile={deleteProfile}
              accent="bg-sky-500/15"
            />
          </div>

          {planError ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
              <strong className="mr-2">Introspection failed:</strong>
              <span className="font-mono text-xs">{planError}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <p className="text-xs text-slate-500">
              Passwords are never persisted in the browser. Saved profiles are encrypted
              (AES-256-GCM) inside the local application database.
            </p>
            <Button onClick={() => void analyze()} disabled={analyzing}>
              {analyzing ? <Spinner /> : "🔍"} Analyze schemas
            </Button>
          </div>

          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">
                  Engine self-test
                </h3>
                <p className="mt-1 max-w-2xl text-xs text-slate-400">
                  Runs the real planner, type-coercion, batch writer, sequence re-sync and
                  validator against a throwaway Prisma-style schema in the local
                  PostgreSQL — no MySQL server required. Use it to confirm the engine
                  behaves before pointing it at production data.
                </p>
              </div>
              <Button variant="ghost" onClick={() => void runSelfTest()} disabled={selftesting}>
                {selftesting ? <Spinner /> : "🧪"} Run self-test
              </Button>
            </div>
            {selftest ? (
              <div className="mt-4 space-y-2">
                {selftest.steps.map((s) => (
                  <div
                    key={s.name}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs"
                  >
                    <Badge tone={s.ok ? "ok" : "error"}>{s.ok ? "pass" : "fail"}</Badge>
                    <span className="text-slate-200">{s.name}</span>
                    <span className="w-full font-mono text-[11px] text-slate-500 sm:w-auto">
                      {s.detail}
                    </span>
                  </div>
                ))}
                {selftest.error ? (
                  <p className="font-mono text-xs text-rose-300">{selftest.error}</p>
                ) : null}
              </div>
            ) : null}
          </Card>

          {runs.length ? (
            <Card className="p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Recent runs</h3>
              <div className="space-y-2">
                {runs.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs"
                  >
                    <Badge tone={r.status === "completed" ? "ok" : r.status === "failed" ? "error" : "pending"}>
                      {r.status}
                    </Badge>
                    <span className="font-mono text-slate-400">{r.sourceLabel}</span>
                    <span className="text-slate-600">→</span>
                    <span className="font-mono text-slate-400">{r.targetLabel}</span>
                    <span className="ml-auto text-slate-500">
                      {r.totalTables} tables · {nf.format(r.totalRowsWritten)} rows
                      {r.totalRowsFailed ? ` · ${nf.format(r.totalRowsFailed)} failed` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------------------- step 2 */}
      {step === 1 ? (
        <div className="space-y-6">
          {!plan ? (
            <Card className="p-10 text-center text-sm text-slate-400">
              No plan yet. Go back to <strong>Connect</strong> and run{" "}
              <em>Analyze schemas</em>.
            </Card>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <Stat label="MySQL tables" value={nf.format(plan.sourceTableCount)} />
                <Stat label="PostgreSQL tables" value={nf.format(plan.targetTableCount)} />
                <Stat label="Selected" value={nf.format(totals.tables)} tone="sky" />
                <Stat label="Rows to copy" value={nf.format(totals.rows)} tone="emerald" />
              </div>

              {plan.warnings.length ? (
                <div className="space-y-2">
                  {plan.warnings.map((w) => (
                    <div
                      key={w}
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200"
                    >
                      ⚠ {w}
                    </div>
                  ))}
                </div>
              ) : null}

              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 p-4">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter tables…"
                    className="w-56 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-600"
                  />
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setSelected(
                        new Set(
                          plan.tables
                            .filter((t) => t.targetTable && t.columns.length)
                            .map((t) => t.sourceTable),
                        ),
                      )
                    }
                  >
                    Select all mappable
                  </Button>
                  <Button variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  <span className="ml-auto text-xs text-slate-500">
                    Ordered by foreign-key dependency (parents first)
                  </span>
                </div>

                <div className="max-h-[520px] overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-slate-900/95 text-[11px] uppercase tracking-wider text-slate-500 backdrop-blur">
                      <tr>
                        <th className="w-10 px-4 py-3" />
                        <th className="px-2 py-3">MySQL table</th>
                        <th className="px-2 py-3">PostgreSQL table</th>
                        <th className="px-2 py-3 text-right">Source rows</th>
                        <th className="px-2 py-3 text-right">Target rows</th>
                        <th className="px-2 py-3 text-right">Columns</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {visibleTables.map((t) => {
                        const disabled = !t.targetTable || t.columns.length === 0;
                        const checked = selected.has(t.sourceTable);
                        return (
                          <tr
                            key={t.sourceTable}
                            className={`transition ${
                              disabled ? "opacity-50" : "hover:bg-slate-800/30"
                            }`}
                          >
                            <td className="px-4 py-2.5">
                              <input
                                type="checkbox"
                                disabled={disabled}
                                checked={checked}
                                onChange={(e) => {
                                  const next = new Set(selected);
                                  if (e.target.checked) next.add(t.sourceTable);
                                  else next.delete(t.sourceTable);
                                  setSelected(next);
                                }}
                                className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-sky-500"
                              />
                            </td>
                            <td className="px-2 py-2.5 font-mono text-xs text-amber-200">
                              {t.sourceTable}
                            </td>
                            <td className="px-2 py-2.5 font-mono text-xs text-sky-200">
                              {t.targetTable ?? "—"}
                            </td>
                            <td className="px-2 py-2.5 text-right tabular-nums text-slate-300">
                              {nf.format(t.sourceRows)}
                            </td>
                            <td className="px-2 py-2.5 text-right tabular-nums text-slate-500">
                              {t.targetRows === null ? "—" : nf.format(t.targetRows)}
                            </td>
                            <td className="px-2 py-2.5 text-right tabular-nums text-slate-400">
                              {t.columns.length}
                              {t.unmappedSourceColumns.length ? (
                                <span className="text-amber-400">
                                  {" "}
                                  (−{t.unmappedSourceColumns.length})
                                </span>
                              ) : null}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-col gap-1">
                                <Badge tone={t.status}>{t.status}</Badge>
                                {t.notes.length ? (
                                  <span className="text-[10px] leading-tight text-slate-500">
                                    {t.notes[0]}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
                <Card className="p-5">
                  <h3 className="mb-4 text-sm font-semibold text-slate-200">
                    Migration options
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Toggle
                      checked={options.truncateTarget}
                      onChange={(v) => setOptions({ ...options, truncateTarget: v })}
                      label="Truncate target tables first"
                      description="TRUNCATE … RESTART IDENTITY CASCADE before inserting."
                    />
                    <Toggle
                      checked={options.disableTriggers}
                      onChange={(v) => setOptions({ ...options, disableTriggers: v })}
                      label="Defer foreign keys"
                      description="session_replication_role = replica (needs superuser)."
                    />
                    <Toggle
                      checked={options.onConflictDoNothing}
                      onChange={(v) => setOptions({ ...options, onConflictDoNothing: v })}
                      label="ON CONFLICT DO NOTHING"
                      description="Idempotent re-runs; duplicates are skipped."
                    />
                    <Toggle
                      checked={options.resetSequences}
                      onChange={(v) => setOptions({ ...options, resetSequences: v })}
                      label="Re-sync identity sequences"
                      description="setval() so Prisma autoincrement keeps working."
                    />
                    <Toggle
                      checked={options.continueOnError}
                      onChange={(v) => setOptions({ ...options, continueOnError: v })}
                      label="Continue on error"
                      description="Retry failed batches row-by-row instead of aborting."
                    />
                    <Toggle
                      checked={options.readTimestampsAsUtc}
                      onChange={(v) => setOptions({ ...options, readTimestampsAsUtc: v })}
                      label="Read MySQL timestamps as UTC"
                      description="SET time_zone='+00:00' and tag timestamptz values."
                    />
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        Batch size · {options.batchSize} rows per INSERT
                      </span>
                      <input
                        type="range"
                        min={50}
                        max={2000}
                        step={50}
                        value={options.batchSize}
                        onChange={(e) =>
                          setOptions({ ...options, batchSize: Number(e.target.value) })
                        }
                        className="w-full accent-sky-500"
                      />
                    </label>
                  </div>
                </Card>

                <Card className="flex flex-col justify-between p-5">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200">Ready to run</h3>
                    <p className="mt-2 text-xs text-slate-400">
                      {nf.format(totals.tables)} table(s), roughly{" "}
                      {nf.format(totals.rows)} rows will be copied into{" "}
                      <span className="font-mono text-sky-300">
                        {pgCfg.database}.{pgCfg.schema ?? "public"}
                      </span>
                      .
                    </p>
                    {options.truncateTarget ? (
                      <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                        Existing rows in the selected target tables will be deleted.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    className="mt-4 w-full"
                    onClick={() => void startMigration()}
                    disabled={starting || totals.tables === 0}
                  >
                    {starting ? <Spinner /> : "🚀"} Start migration
                  </Button>
                </Card>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ---------------------------------------------------------- step 3 */}
      {step === 2 ? (
        <div className="space-y-6">
          {!job && !jobId ? (
            <Card className="p-10 text-center text-sm text-slate-400">
              No migration has been started yet.
            </Card>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <Stat
                  label="Status"
                  value={job?.status ?? "starting"}
                  tone={
                    job?.status === "completed"
                      ? "emerald"
                      : job?.status === "failed"
                        ? "rose"
                        : "sky"
                  }
                />
                <Stat label="Rows read" value={nf.format(jobTotals.read)} />
                <Stat
                  label="Rows inserted"
                  value={nf.format(jobTotals.written)}
                  tone="emerald"
                />
                <Stat
                  label="Rows failed"
                  value={nf.format(jobTotals.failed)}
                  tone={jobTotals.failed ? "rose" : "slate"}
                />
              </div>

              <Card className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">
                    Tables ({jobTotals.done}/{job?.tables.length ?? 0})
                  </h3>
                  {job?.status === "running" ? (
                    <Button variant="danger" onClick={() => void cancelMigration()}>
                      Stop
                    </Button>
                  ) : (
                    <Button onClick={() => setStep(3)}>Go to validation →</Button>
                  )}
                </div>
                <div className="max-h-72 space-y-2 overflow-auto pr-1">
                  {(job?.tables ?? []).map((t) => {
                    const pct = t.totalRows
                      ? (t.rowsRead / t.totalRows) * 100
                      : t.status === "done"
                        ? 100
                        : 0;
                    return (
                      <div
                        key={t.sourceTable}
                        className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                          <Badge tone={t.status}>{t.status}</Badge>
                          <span className="font-mono text-amber-200">{t.sourceTable}</span>
                          <span className="text-slate-600">→</span>
                          <span className="font-mono text-sky-200">{t.targetTable}</span>
                          <span className="ml-auto tabular-nums text-slate-400">
                            {nf.format(t.rowsWritten)} / {nf.format(t.totalRows)}
                            {t.rowsFailed ? (
                              <span className="text-rose-400">
                                {" "}
                                · {nf.format(t.rowsFailed)} failed
                              </span>
                            ) : null}
                            {t.durationMs ? (
                              <span className="text-slate-600"> · {t.durationMs} ms</span>
                            ) : null}
                          </span>
                        </div>
                        <Progress
                          value={pct}
                          tone={
                            t.status === "failed"
                              ? "rose"
                              : t.status === "done"
                                ? "emerald"
                                : t.status === "running"
                                  ? "sky"
                                  : "slate"
                          }
                        />
                        {t.message ? (
                          <p className="mt-2 font-mono text-[11px] text-rose-300">
                            {t.message}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </Card>

              <Card className="overflow-hidden">
                <div className="border-b border-slate-800 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Live log
                </div>
                <div
                  ref={logRef}
                  className="h-72 overflow-auto bg-slate-950/70 p-4 font-mono text-[11px] leading-relaxed"
                >
                  {logs.length === 0 ? (
                    <p className="text-slate-600">waiting for output…</p>
                  ) : (
                    logs.map((l, i) => (
                      <div key={`${l.ts}-${i}`} className="flex gap-3">
                        <span className="shrink-0 text-slate-700">
                          {new Date(l.ts).toLocaleTimeString()}
                        </span>
                        <span
                          className={
                            l.level === "error"
                              ? "text-rose-300"
                              : l.level === "warn"
                                ? "text-amber-300"
                                : l.level === "success"
                                  ? "text-emerald-300"
                                  : "text-slate-300"
                          }
                        >
                          {l.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      ) : null}

      {/* ---------------------------------------------------------- step 4 */}
      {step === 3 ? (
        <div className="space-y-6">
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">
                Post-migration validation
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                Compares row counts table by table and checks that every identity
                sequence is ahead of the largest primary key — the two things that break
                Prisma right after a data migration.
              </p>
            </div>
            <Button onClick={() => void runValidation()} disabled={validating}>
              {validating ? <Spinner /> : "✅"} Run validation
            </Button>
          </Card>

          {validationError ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 font-mono text-xs text-rose-200">
              {validationError}
            </div>
          ) : null}

          {validation ? (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <Stat label="Tables checked" value={nf.format(validation.summary.tables)} />
                <Stat label="Matching" value={nf.format(validation.summary.ok)} tone="emerald" />
                <Stat
                  label="Mismatched"
                  value={nf.format(validation.summary.mismatch)}
                  tone={validation.summary.mismatch ? "rose" : "slate"}
                />
                <Stat
                  label="Rows MySQL → PG"
                  value={`${nf.format(validation.summary.sourceRows)} → ${nf.format(
                    validation.summary.targetRows,
                  )}`}
                />
              </div>

              <Card className="overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-900/95 text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Table</th>
                      <th className="px-2 py-3 text-right">MySQL</th>
                      <th className="px-2 py-3 text-right">PostgreSQL</th>
                      <th className="px-2 py-3 text-right">Diff</th>
                      <th className="px-2 py-3">Sequence</th>
                      <th className="px-4 py-3">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {validation.rows.map((r) => (
                      <tr key={r.table} className="hover:bg-slate-800/30">
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-xs text-amber-200">{r.table}</span>
                          <span className="mx-2 text-slate-600">→</span>
                          <span className="font-mono text-xs text-sky-200">
                            {r.targetTable}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-slate-300">
                          {nf.format(r.sourceRows)}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-slate-300">
                          {nf.format(r.targetRows)}
                        </td>
                        <td
                          className={`px-2 py-2.5 text-right tabular-nums ${
                            r.diff === 0 ? "text-slate-500" : "text-rose-300"
                          }`}
                        >
                          {r.diff > 0 ? `+${r.diff}` : r.diff}
                        </td>
                        <td className="px-2 py-2.5 text-[11px] text-slate-500">
                          {r.sequence ? (
                            <span className={r.sequenceOk === false ? "text-rose-300" : ""}>
                              next {nf.format(r.sequenceValue ?? 0)} · max pk{" "}
                              {r.maxPk === null ? "—" : nf.format(r.maxPk)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge tone={r.status}>{r.status}</Badge>
                          {r.message ? (
                            <p className="mt-1 font-mono text-[10px] text-rose-300">
                              {r.message}
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          ) : null}

          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-200">
              Prisma checklist after the migration
            </h3>
            <ol className="space-y-2 text-xs text-slate-400">
              {[
                ["npx prisma validate", "schema.prisma is still syntactically valid"],
                [
                  "npx prisma db pull --print",
                  "confirm the live PostgreSQL schema matches your model definitions",
                ],
                [
                  "npx prisma migrate status",
                  "make sure no migration is pending after the data load",
                ],
                [
                  "npx prisma generate",
                  "regenerate the client against the PostgreSQL datasource",
                ],
              ].map(([cmd, why]) => (
                <li key={cmd} className="flex flex-wrap items-baseline gap-3">
                  <code className="rounded bg-slate-950/80 px-2 py-1 font-mono text-[11px] text-sky-300">
                    {cmd}
                  </code>
                  <span>{why}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-[11px] text-slate-500">
              Tip: if an <code className="text-slate-300">autoincrement()</code> insert
              fails with a unique-constraint error right after migrating, the identity
              sequence is behind the copied ids. Re-run the validation above — the
              sequence column tells you exactly which table is out of sync, and re-running
              the migration with “Re-sync identity sequences” enabled fixes it.
            </p>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  const tones: Record<string, string> = {
    slate: "text-slate-100",
    sky: "text-sky-300",
    emerald: "text-emerald-300",
    rose: "text-rose-300",
  };
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`mt-1 truncate text-xl font-bold tabular-nums ${tones[tone]}`}>
        {value}
      </p>
    </div>
  );
}
