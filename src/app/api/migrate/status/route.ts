import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0;

  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing job id." }, { status: 400 });
  }
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ ok: false, error: "Unknown job id." }, { status: 404 });
  }

  const logs = job.logs.slice(since);
  return NextResponse.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      currentTable: job.currentTable,
      tables: job.tables,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      logCursor: job.logs.length,
      logs,
    },
  });
}
