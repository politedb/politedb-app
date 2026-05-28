import type { TableSort } from "src/hooks/queries";
import type { DatabaseEngine, TableConstraint } from "src/types";

export type TableColumnForSort = {
  name: string | null;
  is_primary?: boolean;
};

const ENGINES_WITHOUT_STABLE_ORDER: DatabaseEngine[] = [
  "mongo",
  "redis",
  "cassandra",
];

function isTruthyPrimary(value: unknown): boolean {
  return value === true || String(value ?? "").toLowerCase() === "true";
}

function getPrimaryKeyColumns(
  constraints: TableConstraint[] | null | undefined
): string[] {
  if (!constraints?.length) return [];

  const pkConstraint = constraints.find(
    (c) =>
      isTruthyPrimary(c.is_primary) ||
      c.index_name.toLowerCase() === "primary" ||
      c.index_name.toLowerCase().includes("pkey") ||
      (c.is_unique && c.index_name.toLowerCase().includes("primary"))
  );

  if (!pkConstraint?.column_name) return [];

  return pkConstraint.column_name
    .split(",")
    .map((col) => col.trim())
    .filter(Boolean);
}

/** Stable ORDER BY for paginated table scans (PK → `id` → first column). */
export function resolveDefaultTableSort(args: {
  columns?: TableColumnForSort[] | null;
  constraints?: TableConstraint[] | null;
  engine?: DatabaseEngine;
}): TableSort | null {
  const { columns, constraints, engine } = args;
  if (engine && ENGINES_WITHOUT_STABLE_ORDER.includes(engine)) {
    return null;
  }

  const pkFromConstraints = getPrimaryKeyColumns(constraints ?? null);
  if (pkFromConstraints.length > 0) {
    return { colName: pkFromConstraints[0]!, direction: "asc" };
  }

  const namedColumns = (columns ?? []).filter(
    (c): c is TableColumnForSort & { name: string } =>
      Boolean((c.name ?? "").trim())
  );

  const pkFromColumns = namedColumns
    .filter((c) => isTruthyPrimary(c.is_primary))
    .map((c) => c.name);
  if (pkFromColumns.length > 0) {
    return { colName: pkFromColumns[0]!, direction: "asc" };
  }

  const idColumn = namedColumns.find((c) => c.name.toLowerCase() === "id");
  if (idColumn) {
    return { colName: idColumn.name, direction: "asc" };
  }

  if (namedColumns.length > 0) {
    return { colName: namedColumns[0]!.name, direction: "asc" };
  }

  return null;
}

export function cellIsTruthyPrimary(value: unknown): boolean {
  return isTruthyPrimary(value);
}
