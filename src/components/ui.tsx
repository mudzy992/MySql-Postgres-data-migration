"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 backdrop-blur ${className}`}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
        {hint ? <span className="font-normal normal-case text-slate-500">{hint}</span> : null}
      </span>
      <input
        {...props}
        className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 disabled:opacity-50"
      />
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-left transition hover:border-slate-700"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? "bg-sky-500" : "bg-slate-700"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
      <span>
        <span className="block text-sm font-medium text-slate-200">{label}</span>
        {description ? (
          <span className="block text-xs text-slate-500">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

const badgeTones: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  ready: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  success: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  partial: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  mismatch: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  running: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  pending: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  skipped: "bg-slate-500/15 text-slate-400 border-slate-600/40",
  "no-target": "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "no-columns": "bg-rose-500/15 text-rose-300 border-rose-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        badgeTones[tone] ?? badgeTones.pending
      }`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger" | "subtle";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-sky-500 text-white hover:bg-sky-400 shadow-lg shadow-sky-500/20 disabled:bg-slate-700 disabled:shadow-none",
    ghost:
      "border border-slate-700 text-slate-200 hover:border-slate-500 hover:text-white",
    subtle: "bg-slate-800 text-slate-200 hover:bg-slate-700",
    danger: "bg-rose-500/90 text-white hover:bg-rose-500",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Progress({ value, tone = "sky" }: { value: number; tone?: string }) {
  const tones: Record<string, string> = {
    sky: "bg-sky-500",
    emerald: "bg-emerald-500",
    rose: "bg-rose-500",
    amber: "bg-amber-500",
    slate: "bg-slate-600",
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div
        className={`h-full rounded-full transition-all duration-300 ${tones[tone] ?? tones.sky}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
  );
}
