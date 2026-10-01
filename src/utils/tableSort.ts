import type { TableSort } from "src/lib/queries/sql";
import type { DatabaseEngine, TableConstraint } from "src/types";
import {
  cellIsTruthy,
  resolvePrimaryKeyColumns,
} from "src/utils/primaryKey";

export type TableColumnForSort = {
  name: string | null;
  is_primary?: boolean;
};

const ENGINES_WITHOUT_STABLE_ORDER: DatabaseEngine[] = [
  "mongo",
  "redis",
  "cassandra",
];

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

  const pkColumns = resolvePrimaryKeyColumns({ constraints, columns });
  if (pkColumns.length > 0) {
    return { colName: pkColumns[0]!, direction: "asc" };
  }

  const namedColumns = (columns ?? []).filter(
    (c): c is TableColumnForSort & { name: string } =>
      Boolean((c.name ?? "").trim())
  );

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
  return cellIsTruthy(value);
}
