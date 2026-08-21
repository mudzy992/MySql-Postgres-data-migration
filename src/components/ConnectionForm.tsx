"use client";

import { useState } from "react";
import { Badge, Button, Card, Field, Spinner } from "./ui";

export type ConnForm = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema?: string;
  ssl: boolean;
};

export type Profile = ConnForm & { id: number; name: string; kind: string };

export type TestResult = { ok: boolean; info?: string; error?: string; tableCount?: number };

export function ConnectionForm({
  kind,
  value,
  onChange,
  profiles,
  onSaveProfile,
  onDeleteProfile,
  accent,
}: {
  kind: "mysql" | "postgres";
  value: ConnForm;
  onChange: (v: ConnForm) => void;
  profiles: Profile[];
  onSaveProfile: (name: string) => Promise<void>;
  onDeleteProfile: (id: number) => Promise<void>;
  accent: string;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [profileName, setProfileName] = useState("");
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const applyUrl = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    try {
      const parsed = new URL(text.replace(/^jdbc:/, ""));
      const params = parsed.searchParams;
      onChange({
        host: parsed.hostname || "127.0.0.1",
        port: Number(parsed.port || (kind === "mysql" ? 3306 : 5432)),
        user: decodeURIComponent(parsed.username || ""),
        password: decodeURIComponent(parsed.password || ""),
        database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
        schema: kind === "postgres" ? (params.get("schema") ?? "public") : undefined,
        ssl:
          params.get("sslmode") === "require" ||
          params.get("ssl") === "true" ||
          params.get("sslaccept") === "strict",
      });
      setUrlError(null);
      setUrl("");
    } catch {
      setUrlError("Could not parse that connection URL.");
    }
  };

  const set = <K extends keyof ConnForm>(key: K, v: ConnForm[K]) =>
    onChange({ ...value, [key]: v });

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/connections/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, config: value }),
      });
      setResult((await res.json()) as TestResult);
    } catch (error) {
      setResult({ ok: false, error: (error as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const mine = profiles.filter((p) => p.kind === kind);

  return (
    <Card className="flex h-full flex-col p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-lg text-lg ${accent}`}
          >
            {kind === "mysql" ? "🐬" : "🐘"}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              {kind === "mysql" ? "Source · MySQL" : "Target · PostgreSQL"}
            </h3>
            <p className="text-xs text-slate-500">
              {kind === "mysql"
                ? "Read-only. Nothing is written to this database."
                : "Schema created by Prisma. Only data is inserted."}
            </p>
          </div>
        </div>
      </div>

      {mine.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {mine.map((p) => (
            <span
              key={p.id}
              className="group inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 py-1 pl-3 pr-1 text-xs text-slate-300"
            >
              <button
                type="button"
                className="hover:text-white"
                onClick={() =>
                  onChange({
                    host: p.host,
                    port: p.port,
                    user: p.user,
                    password: p.password,
                    database: p.database,
                    schema: p.schema,
                    ssl: p.ssl,
                  })
                }
              >
                {p.name}
              </button>
              <button
                type="button"
                onClick={() => void onDeleteProfile(p.id)}
                className="rounded-full px-1.5 text-slate-600 hover:bg-rose-500/20 hover:text-rose-300"
                aria-label="Delete profile"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mb-4">
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyUrl(url);
            }}
            placeholder={
              kind === "mysql"
                ? "mysql://user:pass@host:3306/legacy_app"
                : "postgresql://user:pass@host:5432/app_db?schema=public"
            }
            className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-600"
          />
          <Button variant="ghost" onClick={() => applyUrl(url)}>
            Fill from URL
          </Button>
        </div>
        {urlError ? (
          <p className="mt-1 text-[11px] text-rose-300">{urlError}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field
            label="Host"
            value={value.host}
            placeholder="127.0.0.1"
            onChange={(e) => set("host", e.target.value)}
          />
        </div>
        <Field
          label="Port"
          type="number"
          value={value.port}
          onChange={(e) => set("port", Number(e.target.value))}
        />
        <Field
          label="User"
          value={value.user}
          placeholder={kind === "mysql" ? "root" : "postgres"}
          onChange={(e) => set("user", e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          value={value.password}
          placeholder="••••••••"
          onChange={(e) => set("password", e.target.value)}
        />
        <Field
          label="Database"
          value={value.database}
          placeholder={kind === "mysql" ? "legacy_app" : "app_db"}
          onChange={(e) => set("database", e.target.value)}
        />
        {kind === "postgres" ? (
          <Field
            label="Schema"
            value={value.schema ?? "public"}
            placeholder="public"
            onChange={(e) => set("schema", e.target.value)}
          />
        ) : null}
        <label className="flex items-end pb-1">
          <span className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={value.ssl}
              onChange={(e) => set("ssl", e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-sky-500"
            />
            Use SSL/TLS
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => void test()} disabled={testing} variant="subtle">
          {testing ? <Spinner /> : "🔌"} Test connection
        </Button>
        <div className="flex flex-1 items-center gap-2">
          <input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder="Save as profile…"
            className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-600"
          />
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void onSaveProfile(profileName).finally(() => {
                setSaving(false);
                setProfileName("");
              });
            }}
          >
            Save
          </Button>
        </div>
      </div>

      {result ? (
        <div
          className={`mt-4 rounded-lg border p-3 text-xs ${
            result.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          <div className="mb-1 flex items-center gap-2">
            <Badge tone={result.ok ? "ok" : "error"}>
              {result.ok ? "connected" : "failed"}
            </Badge>
            {result.ok && result.tableCount !== undefined ? (
              <span className="text-slate-400">{result.tableCount} tables</span>
            ) : null}
          </div>
          <p className="font-mono leading-relaxed break-words">
            {result.ok ? result.info : result.error}
          </p>
        </div>
      ) : null}
    </Card>
  );
}
