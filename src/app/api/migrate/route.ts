import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createJob, getJob, requestCancel } from "@/lib/jobs";
import { runMigration } from "@/lib/migrator";
import {
  errorMessage,
  parseMySqlConfig,
  parseOptions,
  parsePgConfig,
} from "@/lib/request";
import type { TablePlan } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      mysql?: unknown;
      postgres?: unknown;
      options?: unknown;
      tables?: TablePlan[];
    };

    const mysqlConfig = parseMySqlConfig(body.mysql);
    const pgConfig = parsePgConfig(body.postgres);
    const options = parseOptions(body.options);
    const plans = (body.tables ?? []).filter(
      (t) => t && t.targetTable && Array.isArray(t.columns) && t.columns.length > 0,
    );

    if (plans.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Select at least one mappable table." },
        { status: 400 },
      );
    }

    const job = createJob({
      id: crypto.randomUUID(),
      status: "running",
      createdAt: Date.now(),
      finishedAt: null,
      currentTable: null,
      error: null,
      options,
      sourceLabel: `mysql://${mysqlConfig.host}:${mysqlConfig.port}/${mysqlConfig.database}`,
      targetLabel: `postgres://${pgConfig.host}:${pgConfig.port}/${pgConfig.database}?schema=${pgConfig.schema}`,
      tables: plans.map((p) => ({
        sourceTable: p.sourceTable,
        targetTable: p.targetTable as string,
        totalRows: p.sourceRows,
        rowsRead: 0,
        rowsWritten: 0,
        rowsFailed: 0,
        status: "pending" as const,
        durationMs: 0,
      })),
    });

    // Fire and forget — progress is polled from /api/migrate/status.
    void runMigration(job, mysqlConfig, pgConfig, plans, options);

    return NextResponse.json({ ok: true, jobId: job.id });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !getJob(id)) {
    return NextResponse.json({ ok: false, error: "Unknown job." }, { status: 404 });
  }
  const cancelled = requestCancel(id);
  return NextResponse.json({ ok: cancelled });
}
