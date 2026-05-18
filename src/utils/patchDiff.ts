import type { PatchMap } from "./generateSql";
import { cellToString } from "./convert";
import { isBlobColumnType, isJsonColumnType } from "./sqlDialect";

export type PatchCellDiff = {
  column: string;
  oldValue: string;
  newValue: string;
};

export type PatchRowDiff = {
  table: string;
  action: "insert" | "update" | "delete";
  rowKey: string;
  identity: string;
  cells: PatchCellDiff[];
};

function tableLabel(schema: string, tableName: string) {
  return schema ? `${schema}.${tableName}` : tableName;
}

function displayValue(value: unknown) {
  return cellToString(value, true) ?? "";
}

function isTruthy(value: unknown) {
  return value === true || String(value ?? "").toLowerCase() === "true";
}

function primaryKeyColumns(
  constraints: Array<{
    index_name: string;
    is_primary?: boolean | string;
    is_unique?: boolean | string;
    column_name: string;
  }> | null
) {
  const constraint = constraints?.find(
    (item) =>
      isTruthy(item.is_primary) ||
      item.index_name.toLowerCase() === "primary" ||
      item.index_name.toLowerCase().includes("pkey")
  );
  return (constraint?.column_name ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function virtualIdentityColumns(
  columns: Array<{ name: string; db_type?: string }>
) {
  return columns.filter(
    (column) =>
      !isJsonColumnType(column.db_type) && !isBlobColumnType(column.db_type)
  );
}

function rowIdentity(
  columns: Array<{ name: string; db_type?: string }>,
  row: unknown[] | undefined,
  rowKey: string,
  pkColumns: string[]
) {
  if (!row) return `Row ${rowKey}`;
  const identityColumns = pkColumns.length
    ? columns.filter((column) => pkColumns.includes(column.name))
    : virtualIdentityColumns(columns);
  const parts = identityColumns.slice(0, 3).map((column) => {
    const index = columns.findIndex((item) => item.name === column.name);
    const value = cellToString(row[index], true);
    return `${column.name}=${value || "NULL"}`;
  });
  const label = pkColumns.length ? "Primary key" : "Virtual key";
  return parts.length ? `${label}: ${parts.join(", ")}` : `Row ${rowKey}`;
}

export function buildPatchDiffs(
  patchMap: PatchMap,
  options?: {
    activeScreen?: string;
    getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
    getOriginalRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
    offset?: number;
  }
): PatchRowDiff[] {
  const diffs: PatchRowDiff[] = [];
  const { activeScreen, getRowAt, getOriginalRowAt, offset = 0 } = options ?? {};

  const resolveOriginalRow = (tableKey: string, rowIndex: number) => {
    const candidates = [rowIndex + offset, rowIndex];
    for (const candidate of candidates) {
      const cached = getOriginalRowAt?.(tableKey, candidate);
      if (Array.isArray(cached)) return cached;
    }
    for (const candidate of candidates) {
      const row = getRowAt?.(tableKey, candidate);
      if (Array.isArray(row)) return row;
    }
    return undefined;
  };

  for (const entry of Object.values(patchMap)) {
    const { tableData, tableWindow, patches } = entry;
    if (!tableData || !tableWindow || !patches) continue;

    const { schema, name } = tableWindow.table;
    const table = tableLabel(schema, name);
    const columns = tableData.columns ?? [];
    const pkColumns = primaryKeyColumns(tableData.constraints ?? null);
    const tableKey = activeScreen ? `${activeScreen}.${schema}.${name}` : "";

    for (const [rowKey, patch] of Object.entries(patches.create?.data ?? {})) {
      diffs.push({
        table,
        action: "insert",
        rowKey,
        identity: `New row #${rowKey}`,
        cells: Object.entries(patch)
          .filter(([column]) => column !== "__rowKey")
          .map(([column, value]) => ({
            column,
            oldValue: "",
            newValue: displayValue(value),
          })),
      });
    }

    for (const [rowKey, patch] of Object.entries(patches.update?.data ?? {})) {
      const rowIndex = Number(rowKey);
      const originalRow =
        Number.isFinite(rowIndex) && tableKey
          ? resolveOriginalRow(tableKey, rowIndex)
          : undefined;

      diffs.push({
        table,
        action: "update",
        rowKey,
        identity: rowIdentity(columns, originalRow, rowKey, pkColumns),
        cells: Object.entries(patch).map(([column, value]) => {
          const columnIndex = columns.findIndex((item) => item.name === column);
          return {
            column,
            oldValue:
              columnIndex >= 0 ? displayValue(originalRow?.[columnIndex]) : "",
            newValue: displayValue(value),
          };
        }),
      });
    }

    for (const [rowKey] of Object.entries(patches.delete?.data ?? {})) {
      const rowIndex = Number(rowKey);
      const originalRow =
        Number.isFinite(rowIndex) && tableKey
          ? resolveOriginalRow(tableKey, rowIndex)
          : undefined;

      diffs.push({
        table,
        action: "delete",
        rowKey,
        identity: rowIdentity(columns, originalRow, rowKey, pkColumns),
        cells: [],
      });
    }
  }

  return diffs;
}
