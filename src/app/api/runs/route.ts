import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/request";
import { listRuns } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = await listRuns(10);
    return NextResponse.json({ ok: true, runs });
  } catch (error) {
    return NextResponse.json({ ok: true, runs: [], error: errorMessage(error) });
  }
}
