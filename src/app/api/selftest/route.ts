import { NextResponse } from "next/server";
import {
  connectPg,
  countPgRows,
  currentSequenceValue,
  fkDependencies,
  introspectPg,
  resetSequence,
  topoSort,
} from "@/lib/pg";
import { buildPlan, coerceValue } from "@/lib/plan";
import { buildInsert } from "@/lib/migrator";
import { errorMessage } from "@/lib/request";
import type { PgConfig, SourceTable } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCHEMA = "migrator_selftest";

/**
 * Runs the real migration engine (planner + type coercion + batch writer +
 * sequence re-sync + validator) against a throwaway "Prisma-style" schema in
 * the local PostgreSQL instance, using synthetic rows shaped exactly like
 * mysql2 output. Lets you prove the engine works before pointing it at
 * production data.
 */
export async function POST() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL is not configured." },
      { status: 500 },
    );
  }

  let config: PgConfig;
  try {
    const parsed = new URL(url);
    config = {
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ""),
      schema: SCHEMA,
      ssl: false,
    };
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }

  const steps: { name: string; ok: boolean; detail: string }[] = [];
  let client: Awaited<ReturnType<typeof connectPg>> | null = null;

  try {
    client = await connectPg(config);

    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`
      CREATE TABLE ${SCHEMA}."User" (
        "id" SERIAL PRIMARY KEY,
        "email" TEXT NOT NULL UNIQUE,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "profile" JSONB,
        "avatar" BYTEA,
        "createdAt" TIMESTAMPTZ NOT NULL
      )`);
    await client.query(`
      CREATE TABLE ${SCHEMA}."Post" (
        "id" SERIAL PRIMARY KEY,
        "authorId" INTEGER NOT NULL REFERENCES ${SCHEMA}."User"("id"),
        "title" TEXT NOT NULL,
        "body" TEXT,
        "published" BOOLEAN NOT NULL DEFAULT false,
        "publishedAt" TIMESTAMP
      )`);
    steps.push({
      name: "Create throwaway Prisma-style schema",
      ok: true,
      detail: `${SCHEMA}."User" (serial, jsonb, bytea, timestamptz) + ${SCHEMA}."Post" (FK → User)`,
    });

    const targetTables = await introspectPg(client, SCHEMA);
    const deps = await fkDependencies(client, SCHEMA);
    const order = topoSort(
      targetTables.map((t) => t.name),
      deps,
    );
    steps.push({
      name: "Introspect target + FK-safe ordering",
      ok: order.indexOf("User") < order.indexOf("Post"),
      detail: `order = ${order.join(" → ")}`,
    });

    // Synthetic MySQL introspection result (snake_case, plural, MySQL types).
    const sourceTables: SourceTable[] = [
      {
        name: "users",
        rows: 3,
        columns: [
          { name: "id", dataType: "int", columnType: "int(11)", nullable: false },
          {
            name: "email",
            dataType: "varchar",
            columnType: "varchar(191)",
            nullable: false,
          },
          {
            name: "is_active",
            dataType: "tinyint",
            columnType: "tinyint(1)",
            nullable: false,
          },
          { name: "profile", dataType: "json", columnType: "json", nullable: true },
          { name: "avatar", dataType: "blob", columnType: "blob", nullable: true },
          {
            name: "created_at",
            dataType: "datetime",
            columnType: "datetime",
            nullable: false,
          },
          {
            name: "legacy_flag",
            dataType: "varchar",
            columnType: "varchar(10)",
            nullable: true,
          },
        ],
      },
      {
        name: "posts",
        rows: 4,
        columns: [
          { name: "id", dataType: "int", columnType: "int(11)", nullable: false },
          { name: "author_id", dataType: "int", columnType: "int(11)", nullable: false },
          {
            name: "title",
            dataType: "varchar",
            columnType: "varchar(191)",
            nullable: false,
          },
          { name: "body", dataType: "text", columnType: "text", nullable: true },
          {
            name: "published",
            dataType: "tinyint",
            columnType: "tinyint(1)",
            nullable: false,
          },
          {
            name: "published_at",
            dataType: "datetime",
            columnType: "datetime",
            nullable: true,
          },
        ],
      },
    ];

    const plan = buildPlan(sourceTables, targetTables, order);
    const userPlan = plan.tables.find((t) => t.sourceTable === "users");
    const postPlan = plan.tables.find((t) => t.sourceTable === "posts");
    steps.push({
      name: "Auto-map tables & columns",
      ok:
        userPlan?.targetTable === "User" &&
        postPlan?.targetTable === "Post" &&
        userPlan.columns.some((c) => c.source === "is_active" && c.target === "isActive"),
      detail: `users → "User" (${userPlan?.columns.length} cols, ${userPlan?.unmappedSourceColumns.length} unmapped), posts → "Post" (${postPlan?.columns.length} cols)`,
    });

    // Rows exactly as mysql2 hands them over (dateStrings, tinyint as 0/1, Buffers).
    const userRows: Record<string, unknown>[] = [
      {
        id: 1,
        email: "ana@example.com",
        is_active: 1,
        profile: '{"role":"admin","tags":["a","b"]}',
        avatar: Buffer.from("PNGDATA"),
        created_at: "2024-01-15 10:30:00",
        legacy_flag: "x",
      },
      {
        id: 2,
        email: "marko@example.com",
        is_active: 0,
        profile: null,
        avatar: null,
        created_at: "2023-06-01 00:00:00",
        legacy_flag: null,
      },
      {
        id: 7,
        email: "ivana@example.com",
        is_active: 1,
        profile: '{"role":"editor"}',
        avatar: null,
        created_at: "2022-12-31 23:59:59",
        legacy_flag: null,
      },
    ];
    const postRows: Record<string, unknown>[] = [
      {
        id: 1,
        author_id: 1,
        title: "Hello",
        body: "First post",
        published: 1,
        published_at: "2024-02-01 09:00:00",
      },
      {
        id: 2,
        author_id: 7,
        title: "Zero date",
        body: null,
        published: 0,
        published_at: "0000-00-00 00:00:00",
      },
      {
        id: 3,
        author_id: 2,
        title: "Unicode š č ž đ",
        body: "ćirilica: Здраво",
        published: 1,
        published_at: null,
      },
    ];

    for (const [tablePlan, rows] of [
      [userPlan, userRows],
      [postPlan, postRows],
    ] as const) {
      if (!tablePlan?.targetTable) continue;
      const values = rows.map((row) =>
        tablePlan.columns.map((c) =>
          coerceValue(row[c.source], c.udt, c.nullable, true),
        ),
      );
      const sql = buildInsert(
        SCHEMA,
        tablePlan.targetTable,
        tablePlan.columns.map((c) => c.target),
        values.length,
        true,
      );
      await client.query(sql, values.flat());
    }
    steps.push({
      name: "Coerce + batch insert (tinyint→bool, json→jsonb, blob→bytea, 0000-00-00→NULL)",
      ok: true,
      detail: `${userRows.length} users + ${postRows.length} posts inserted in 2 batched statements`,
    });

    const seqUser = await resetSequence(client, SCHEMA, "User", "id");
    const seqPost = await resetSequence(client, SCHEMA, "Post", "id");
    steps.push({
      name: "Re-sync identity sequences",
      ok: (seqUser?.value ?? 0) === 8 && (seqPost?.value ?? 0) === 4,
      detail: `User.id next = ${seqUser?.value}, Post.id next = ${seqPost?.value}`,
    });

    // Prove Prisma-style autoincrement inserts still work afterwards.
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO ${SCHEMA}."User" ("email","isActive","createdAt") VALUES ($1,$2,now()) RETURNING id`,
      ["new-after-migration@example.com", true],
    );
    steps.push({
      name: "autoincrement() still works after the data load",
      ok: (inserted.rows[0]?.id ?? 0) === 8,
      detail: `new row received id = ${inserted.rows[0]?.id}`,
    });

    const userCount = await countPgRows(client, SCHEMA, "User");
    const postCount = await countPgRows(client, SCHEMA, "Post");
    const seqCheck = await currentSequenceValue(client, SCHEMA, "User", "id");
    const sample = await client.query<{
      email: string;
      isActive: boolean;
      profile: unknown;
      avatar: Buffer | null;
      createdAt: Date;
    }>(`SELECT "email","isActive","profile","avatar","createdAt" FROM ${SCHEMA}."User" WHERE id = 1`);
    const zeroDate = await client.query<{ publishedAt: Date | null }>(
      `SELECT "publishedAt" FROM ${SCHEMA}."Post" WHERE id = 2`,
    );
    const row = sample.rows[0];
    steps.push({
      name: "Validate row counts, types and values",
      ok:
        userCount === 4 &&
        postCount === 3 &&
        row?.isActive === true &&
        (row?.profile as { role?: string })?.role === "admin" &&
        row?.avatar?.toString() === "PNGDATA" &&
        zeroDate.rows[0]?.publishedAt === null,
      detail: `User=${userCount} rows, Post=${postCount} rows · isActive=${row?.isActive} · profile.role=${
        (row?.profile as { role?: string })?.role
      } · avatar="${row?.avatar?.toString()}" · zero-date → ${
        zeroDate.rows[0]?.publishedAt === null ? "NULL" : "value"
      } · seq(last)=${seqCheck?.value}`,
    });

    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    steps.push({ name: "Clean up throwaway schema", ok: true, detail: "dropped" });

    return NextResponse.json({
      ok: steps.every((s) => s.ok),
      steps,
    });
  } catch (error) {
    steps.push({ name: "Unexpected failure", ok: false, detail: errorMessage(error) });
    try {
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } catch {
      /* ignore */
    }
    return NextResponse.json({ ok: false, steps, error: errorMessage(error) });
  } finally {
    try {
      await client?.end();
    } catch {
      /* ignore */
    }
  }
}
