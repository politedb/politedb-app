import type { ColumnMeta } from "src/lib/tauri/types";
import type { DataAction, DataKey } from "src/stores/connection";
import { cellToString } from "src/utils/convert";

type PatchHelpers = {
  isNewRow: (rowIndex: number) => boolean;
  getRowKey: (
    rowIndex: number,
    newRows: { rowKey: string; row: Record<string, unknown> }[]
  ) => string;
  getPatchedValue: (
    rowIndex: number,
    colName: string,
    fallback: unknown,
    newRows: { rowKey: string; row: Record<string, unknown> }[]
  ) => unknown;
};

export function commitTableCellEdit(params: {
  rowIdx: number;
  columnName: string;
  newValue: unknown;
  columns: ColumnMeta[];
  getRowArray: (idx: number) => unknown[] | undefined;
  patchHelpers: PatchHelpers;
  newRows: { rowKey: string; row: Record<string, unknown> }[];
  dataKey: DataKey;
  onCellChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, unknown>
  ) => void;
}): boolean {
  const {
    rowIdx,
    columnName,
    newValue,
    columns,
    getRowArray,
    patchHelpers,
    newRows,
    dataKey,
    onCellChange,
  } = params;

  if (rowIdx < 0 || !onCellChange) return false;

  const colIdx = columns.findIndex((c) => c.name === columnName);
  if (colIdx < 0) return false;

  const col = columns[colIdx];
  if (col?.readonly) return false;

  const rowArr = getRowArray(rowIdx);
  const originalValue = rowArr?.[colIdx] ?? null;

  const patchedValue = patchHelpers.getPatchedValue(
    rowIdx,
    columnName,
    originalValue,
    newRows
  );

  const prev = (cellToString(patchedValue) ?? "").trim();
  const next = (cellToString(newValue) ?? "").trim();
  const isNewRow = patchHelpers.isNewRow(rowIdx);

  if (!isNewRow && prev === next) return false;

  const changeData: Record<string, unknown> = { [columnName]: newValue };

  if (isNewRow) {
    changeData.__rowKey = patchHelpers.getRowKey(rowIdx, newRows);
  }

  onCellChange(
    isNewRow ? "create" : "update",
    dataKey,
    isNewRow ? -1 : rowIdx,
    changeData
  );

  return true;
}
