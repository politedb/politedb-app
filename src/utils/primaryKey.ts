import { cellToString } from "./convert";

export type PrimaryKeyConstraint = {
  index_name: string;
  is_primary?: boolean | string | number | null;
  is_unique?: boolean | string | number | null;
  column_name: string;
};

export type PrimaryKeyColumn = {
  name?: string | null;
  is_primary?: unknown;
};

/** Truthy flag from SQL/driver cells (Bool, I64 1, "true"/"1"/"t"/"yes", CellValue wrappers). */
export function cellIsTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const normalized = (cellToString(value as never, true) ?? "")
    .toLowerCase()
    .trim();
  return (
    normalized === "true" ||
    normalized === "t" ||
    normalized === "1" ||
    normalized === "yes"
  );
}

/** Strip common SQL identifier quotes for PK matching. */
export function normalizeIdentName(name: string): string {
  const trimmed = name.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitColumnList(columnName: string | null | undefined): string[] {
  return String(columnName ?? "")
    .split(",")
    .map((col) => normalizeIdentName(col))
    .filter(Boolean);
}

/**
 * The primary key's index among a table's constraints. When the catalog
 * flags rows (is_primary), only a flagged row is the key: a UNIQUE index
 * named like one (orders_legacy_pkey, primary_email, or PostgreSQL's legal
 * "PRIMARY") is never taken for it. The loaders always set the flag (MySQL
 * from index_name = 'PRIMARY'); names (PRIMARY, *_pkey) are guessed only
 * for metadata without it.
 */
export function findPrimaryKeyConstraint<T extends PrimaryKeyConstraint>(
  constraints: T[] | null | undefined
): T | undefined {
  if (!constraints?.length) return undefined;
  const flagged = constraints.find((c) => cellIsTruthy(c.is_primary));
  if (flagged) return flagged;
  if (constraints.some((c) => c.is_primary != null)) return undefined;
  return constraints.find(
    (c) =>
      c.index_name?.toLowerCase() === "primary" ||
      c.index_name?.toLowerCase().includes("pkey") ||
      (cellIsTruthy(c.is_unique) &&
        c.index_name?.toLowerCase().includes("primary"))
  );
}

export function primaryKeyColumnsFromConstraints(
  constraints: PrimaryKeyConstraint[] | null | undefined
): string[] {
  return splitColumnList(findPrimaryKeyConstraint(constraints)?.column_name);
}

export function primaryKeyColumnsFromColumns(
  columns: PrimaryKeyColumn[] | null | undefined
): string[] {
  return (columns ?? [])
    .filter((c) => Boolean((c.name ?? "").trim()) && cellIsTruthy(c.is_primary))
    .map((c) => normalizeIdentName(String(c.name)))
    .filter(Boolean);
}

/**
 * Prefer constraint/index PRIMARY metadata; fall back to column is_primary flags
 * (diagram/columns query) when structure constraints are missing.
 */
export function resolvePrimaryKeyColumns(args: {
  constraints?: PrimaryKeyConstraint[] | null;
  columns?: PrimaryKeyColumn[] | null;
}): string[] {
  const fromConstraints = primaryKeyColumnsFromConstraints(args.constraints);
  if (fromConstraints.length > 0) return fromConstraints;
  return primaryKeyColumnsFromColumns(args.columns);
}

export function primaryKeyColumnSet(pkColumns: string[]): Set<string> {
  return new Set(pkColumns.map((col) => normalizeIdentName(col).toLowerCase()));
}

export function isPrimaryKeyColumn(
  columnName: string,
  pkColumns: string[] | Set<string>
): boolean {
  const set =
    pkColumns instanceof Set ? pkColumns : primaryKeyColumnSet(pkColumns);
  return set.has(normalizeIdentName(columnName).toLowerCase());
}
