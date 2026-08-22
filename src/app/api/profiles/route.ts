import { NextResponse } from "next/server";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { errorMessage } from "@/lib/request";
import { addProfile, deleteProfile, listProfiles } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await listProfiles();
    return NextResponse.json({
      ok: true,
      profiles: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        host: r.host,
        port: r.port,
        user: r.user,
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

    const row = await addProfile({
      name,
      kind,
      host: cfg.host ?? "127.0.0.1",
      port: Number(cfg.port ?? (kind === "mysql" ? 3306 : 5432)),
      user: cfg.user ?? "",
      passwordEnc: encryptSecret(cfg.password ?? ""),
      database: cfg.database ?? "",
      schemaName: kind === "postgres" ? (cfg.schema ?? "public") : null,
      ssl: Boolean(cfg.ssl),
    });

    return NextResponse.json({ ok: true, id: row.id });
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
    await deleteProfile(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}
