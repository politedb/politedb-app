import type { ColumnMeta } from "src/lib/tauri/types";
import type {
  SelectedRowDetail,
  SelectedRowField,
} from "src/stores/connection";
import { cellToString } from "src/utils/convert";

type PatchHelpers = {
  getPatchedValue: (
    rowIndex: number,
    colName: string,
    fallback: unknown,
    newRows: { rowKey: string; row: Record<string, unknown> }[]
  ) => unknown;
};

export function buildSelectedRowFields(
  rowIdx: number,
  columns: ColumnMeta[],
  getRowArray: (idx: number) => unknown[] | undefined,
  patchHelpers: PatchHelpers,
  newRows: { rowKey: string; row: Record<string, unknown> }[]
): SelectedRowField[] | null {
  if (rowIdx < 0) return null;

  const rowArr = getRowArray(rowIdx);
  if (!rowArr) return null;

  return columns.map((col, colIdx) => {
    const raw = patchHelpers.getPatchedValue(
      rowIdx,
      col.name,
      rowArr[colIdx],
      newRows
    );
    const parsed = cellToString(raw, true);
    const isNull = parsed === null;
    return {
      name: col.name,
      value: isNull ? "" : (parsed ?? ""),
      dataType: col.db_type,
      columnDefault: col.column_default,
      isNull,
      readonly: col.readonly,
    };
  });
}

export function buildSelectedRowDetail(
  rowIdx: number,
  columns: ColumnMeta[],
  getRowArray: (idx: number) => unknown[] | undefined,
  patchHelpers: PatchHelpers,
  newRows: { rowKey: string; row: Record<string, unknown> }[]
): SelectedRowDetail | null {
  const fields = buildSelectedRowFields(
    rowIdx,
    columns,
    getRowArray,
    patchHelpers,
    newRows
  );
  if (!fields) return null;
  return { rowIndex: rowIdx, fields };
}
