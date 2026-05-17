import type { PatchMap } from "./generateSql";
import { cellToString } from "./convert";

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

function rowIdentity(
  columns: Array<{ name: string }>,
  row: unknown[] | undefined,
  rowKey: string
) {
  if (!row) return `Row ${rowKey}`;
  const parts = columns.slice(0, 3).map((column, index) => {
    const value = cellToString(row[index], true);
    return `${column.name}=${value || "NULL"}`;
  });
  return parts.length ? parts.join(", ") : `Row ${rowKey}`;
}

export function buildPatchDiffs(
  patchMap: PatchMap,
  options?: {
    activeScreen?: string;
    getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  }
): PatchRowDiff[] {
  const diffs: PatchRowDiff[] = [];
  const { activeScreen, getRowAt } = options ?? {};

  for (const entry of Object.values(patchMap)) {
    const { tableData, tableWindow, patches } = entry;
    if (!tableData || !tableWindow || !patches) continue;

    const { schema, name } = tableWindow.table;
    const table = tableLabel(schema, name);
    const columns = tableData.columns ?? [];
    const tableKey = activeScreen ? `${activeScreen}.${schema}.${name}` : "";

    for (const [rowKey, patch] of Object.entries(patches.create?.data ?? {})) {
      diffs.push({
        table,
        action: "insert",
        rowKey,
        identity: `New row ${rowKey}`,
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
        Number.isFinite(rowIndex) && getRowAt && tableKey
          ? getRowAt(tableKey, rowIndex)
          : undefined;

      diffs.push({
        table,
        action: "update",
        rowKey,
        identity: rowIdentity(columns, originalRow, rowKey),
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
        Number.isFinite(rowIndex) && getRowAt && tableKey
          ? getRowAt(tableKey, rowIndex)
          : undefined;

      diffs.push({
        table,
        action: "delete",
        rowKey,
        identity: rowIdentity(columns, originalRow, rowKey),
        cells: columns.map((column, index) => ({
          column: column.name,
          oldValue: displayValue(originalRow?.[index]),
          newValue: "",
        })),
      });
    }
  }

  return diffs;
}
