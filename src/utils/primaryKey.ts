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

export function primaryKeyColumnsFromConstraints(
  constraints: PrimaryKeyConstraint[] | null | undefined
): string[] {
  if (!constraints?.length) return [];

  const pkConstraint = constraints.find(
    (c) =>
      cellIsTruthy(c.is_primary) ||
      c.index_name?.toLowerCase() === "primary" ||
      c.index_name?.toLowerCase().includes("pkey") ||
      (cellIsTruthy(c.is_unique) &&
        c.index_name?.toLowerCase().includes("primary"))
  );

  return splitColumnList(pkConstraint?.column_name);
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
