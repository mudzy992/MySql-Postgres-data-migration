import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { migrationRuns } from "@/db/schema";
import { errorMessage } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db
      .select()
      .from(migrationRuns)
      .orderBy(desc(migrationRuns.startedAt))
      .limit(10);
    return NextResponse.json({ ok: true, runs: rows });
  } catch (error) {
    return NextResponse.json({ ok: true, runs: [], error: errorMessage(error) });
  }
}
