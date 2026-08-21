import type {
  ColumnMapping,
  MigrationPlan,
  SourceTable,
  TablePlan,
  TargetTable,
} from "./types";

/** `user_profile`, `UserProfile`, `userProfiles` all normalize to `userprofile`. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function singular(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (name.endsWith("ses")) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

function buildLookup<T extends { name: string }>(items: T[]) {
  const exact = new Map<string, T>();
  const normalized = new Map<string, T>();
  const singularized = new Map<string, T>();
  for (const item of items) {
    exact.set(item.name, item);
    const n = normalizeName(item.name);
    if (!normalized.has(n)) normalized.set(n, item);
    const s = singular(n);
    if (!singularized.has(s)) singularized.set(s, item);
  }
  return { exact, normalized, singularized };
}

function findMatch<T extends { name: string }>(
  lookup: ReturnType<typeof buildLookup<T>>,
  name: string,
): T | undefined {
  return (
    lookup.exact.get(name) ??
    lookup.normalized.get(normalizeName(name)) ??
    lookup.singularized.get(singular(normalizeName(name)))
  );
}

export function buildPlan(
  sourceTables: SourceTable[],
  targetTables: TargetTable[],
  order: string[],
): MigrationPlan {
  const targetLookup = buildLookup(targetTables);
  const warnings: string[] = [];
  const usedTargets = new Set<string>();

  const tables: TablePlan[] = sourceTables.map((src) => {
    const target = findMatch(targetLookup, src.name);
    if (!target) {
      return {
        sourceTable: src.name,
        targetTable: null,
        sourceRows: src.rows,
        targetRows: null,
        columns: [],
        unmappedSourceColumns: src.columns.map((c) => c.name),
        missingRequiredColumns: [],
        status: "no-target",
        notes: ["No matching table in the PostgreSQL schema — will be skipped."],
      } satisfies TablePlan;
    }

    usedTargets.add(target.name);
    const colLookup = buildLookup(target.columns);
    const columns: ColumnMapping[] = [];
    const unmapped: string[] = [];
    const notes: string[] = [];

    for (const col of src.columns) {
      const tcol = findMatch(colLookup, col.name);
      if (!tcol) {
        unmapped.push(col.name);
        continue;
      }
      columns.push({
        source: col.name,
        target: tcol.name,
        udt: tcol.udt,
        nullable: tcol.nullable,
      });
    }

    const mappedTargets = new Set(columns.map((c) => c.target));
    const missingRequired = target.columns
      .filter((c) => !c.nullable && !c.hasDefault && !mappedTargets.has(c.name))
      .map((c) => c.name);

    if (unmapped.length) {
      notes.push(`Source columns without a target: ${unmapped.join(", ")}`);
    }
    if (missingRequired.length) {
      notes.push(
        `Target NOT NULL columns with no source data: ${missingRequired.join(", ")}`,
      );
    }
    if (src.name !== target.name) {
      notes.push(`Name mapped: \`${src.name}\` → "${target.name}"`);
    }

    const status: TablePlan["status"] =
      columns.length === 0
        ? "no-columns"
        : unmapped.length || missingRequired.length
          ? "partial"
          : "ready";

    return {
      sourceTable: src.name,
      targetTable: target.name,
      sourceRows: src.rows,
      targetRows: null,
      columns,
      unmappedSourceColumns: unmapped,
      missingRequiredColumns: missingRequired,
      status,
      notes,
    } satisfies TablePlan;
  });

  const orphanTargets = targetTables
    .map((t) => t.name)
    .filter((n) => !usedTargets.has(n) && !n.startsWith("_prisma"));
  if (orphanTargets.length) {
    warnings.push(
      `${orphanTargets.length} PostgreSQL table(s) have no MySQL counterpart: ${orphanTargets
        .slice(0, 12)
        .join(", ")}${orphanTargets.length > 12 ? "…" : ""}`,
    );
  }
  const missing = tables.filter((t) => !t.targetTable).map((t) => t.sourceTable);
  if (missing.length) {
    warnings.push(
      `${missing.length} MySQL table(s) have no PostgreSQL counterpart: ${missing
        .slice(0, 12)
        .join(", ")}${missing.length > 12 ? "…" : ""}`,
    );
  }

  // Sort the plan by FK-safe target order, unmatched tables last.
  const orderIndex = new Map(order.map((name, i) => [name, i]));
  tables.sort((a, b) => {
    const ai = a.targetTable ? (orderIndex.get(a.targetTable) ?? 9998) : 9999;
    const bi = b.targetTable ? (orderIndex.get(b.targetTable) ?? 9998) : 9999;
    if (ai !== bi) return ai - bi;
    return a.sourceTable.localeCompare(b.sourceTable);
  });

  return {
    tables,
    order,
    sourceTableCount: sourceTables.length,
    targetTableCount: targetTables.length,
    warnings,
  };
}

const ZERO_DATE = /^0{4}-0{2}-0{2}([ T]0{2}:0{2}:0{2}(\.0+)?)?$/;

const BOOL_TYPES = new Set(["bool", "boolean"]);
const JSON_TYPES = new Set(["json", "jsonb"]);
const INT_TYPES = new Set(["int2", "int4", "int8", "smallint", "integer", "bigint"]);
const FLOAT_TYPES = new Set(["float4", "float8", "numeric", "decimal", "money"]);
const DATE_TYPES = new Set(["date", "timestamp", "timestamptz", "time", "timetz"]);

/**
 * Converts a value returned by mysql2 into something node-postgres can bind
 * for the given target column type.
 */
export function coerceValue(
  value: unknown,
  udt: string,
  nullable: boolean,
  utc: boolean,
): unknown {
  if (value === null || value === undefined) {
    if (!nullable && BOOL_TYPES.has(udt)) return false;
    return null;
  }

  const type = udt.toLowerCase();

  if (Buffer.isBuffer(value)) {
    if (type === "bytea") return value;
    if (BOOL_TYPES.has(type)) return value.length > 0 && value[0] !== 0;
    if (INT_TYPES.has(type)) {
      let n = 0;
      for (const byte of value) n = n * 256 + byte;
      return n;
    }
    return value.toString("utf8");
  }

  if (BOOL_TYPES.has(type)) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const s = String(value).toLowerCase();
    return s === "1" || s === "true" || s === "t" || s === "y" || s === "yes";
  }

  if (JSON_TYPES.has(type)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }

  if (DATE_TYPES.has(type)) {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const s = String(value);
    if (ZERO_DATE.test(s)) {
      if (nullable) return null;
      return type === "date" ? "1970-01-01" : "1970-01-01 00:00:00";
    }
    if (type === "timestamptz" && utc && !/[+-]\d{2}:?\d{2}$|Z$/i.test(s)) {
      return `${s}+00`;
    }
    return s;
  }

  if (INT_TYPES.has(type) || FLOAT_TYPES.has(type)) {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && value.trim() === "") return null;
    return value;
  }

  if (type.startsWith("_")) {
    // PostgreSQL array target (e.g. Prisma String[]) fed from a MySQL JSON/text column.
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return [];
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
      return trimmed.includes(",") ? trimmed.split(",") : [trimmed];
    }
    return [value];
  }

  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
  }

  return value;
}
