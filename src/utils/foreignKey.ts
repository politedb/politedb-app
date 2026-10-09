import type { ForeignKeyInfo, TableForeignKey } from "src/types";

/** Split engine-aggregated FK column lists (`GROUP_CONCAT` / `string_agg`). */
export function splitFkColumnList(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Find an FK whose column list includes `columnName` (supports composite keys). */
export function findFkForColumn(
  foreignKeys: ForeignKeyInfo[] | null | undefined,
  columnName: string
): ForeignKeyInfo | null {
  if (!foreignKeys?.length || !columnName?.trim()) return null;
  const key = columnName.trim();
  return (
    foreignKeys.find((fk) =>
      splitFkColumnList(fk.column_names).includes(key)
    ) ?? null
  );
}

/**
 * Per-column map for data-grid FK links.
 * Composite constraints (`host_id,software_id`) expand to one entry per local
 * column, paired with the same-ordinal referenced column.
 */
export function buildForeignKeyColumnMap(
  foreignKeys: ForeignKeyInfo[] | null | undefined
): Record<string, TableForeignKey> {
  const out: Record<string, TableForeignKey> = {};
  for (const fk of foreignKeys ?? []) {
    const columns = splitFkColumnList(fk.column_names);
    const refColumns = splitFkColumnList(fk.ref_column_names);
    if (columns.length === 0 || refColumns.length === 0) continue;

    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      const refColumn = refColumns[i] ?? refColumns[0];
      if (!column || !refColumn) continue;
      // First constraint wins when multiple FKs share a column.
      if (out[column]) continue;
      out[column] = {
        schema: fk.ref_table_schema,
        table: fk.ref_table_name,
        column: refColumn,
      };
    }
  }
  return out;
}
