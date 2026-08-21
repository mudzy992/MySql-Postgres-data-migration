import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectionProfiles } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { errorMessage } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db
      .select()
      .from(connectionProfiles)
      .orderBy(desc(connectionProfiles.createdAt));
    return NextResponse.json({
      ok: true,
      profiles: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        host: r.host,
        port: r.port,
        user: r.username,
        password: decryptSecret(r.passwordEnc),
        database: r.database,
        schema: r.schemaName ?? "public",
        ssl: r.ssl,
      })),
    });
  } catch (error) {
    return NextResponse.json({ ok: true, profiles: [], error: errorMessage(error) });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      kind?: string;
      config?: {
        host?: string;
        port?: number;
        user?: string;
        password?: string;
        database?: string;
        schema?: string;
        ssl?: boolean;
      };
    };
    const kind = body.kind === "mysql" ? "mysql" : "postgres";
    const cfg = body.config ?? {};
    const name = (body.name ?? "").trim() || `${kind} · ${cfg.database ?? "db"}`;

    const [row] = await db
      .insert(connectionProfiles)
      .values({
        name,
        kind,
        host: cfg.host ?? "127.0.0.1",
        port: Number(cfg.port ?? (kind === "mysql" ? 3306 : 5432)),
        username: cfg.user ?? "",
        passwordEnc: encryptSecret(cfg.password ?? ""),
        database: cfg.database ?? "",
        schemaName: kind === "postgres" ? (cfg.schema ?? "public") : null,
        ssl: Boolean(cfg.ssl),
      })
      .returning();

    return NextResponse.json({ ok: true, id: row?.id });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const id = Number.parseInt(
      new URL(request.url).searchParams.get("id") ?? "",
      10,
    );
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, error: "Invalid id." }, { status: 400 });
    }
    await db.delete(connectionProfiles).where(eq(connectionProfiles.id, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}
