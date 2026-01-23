import { useCallback, useState } from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cellToString } from "src/utils/convert";
import type { DataAction, DataKey } from "src/stores/connection";

import { EMPTY_ARRAY, EMPTY_SET, EMPTY_OBJECT } from "./tableUtils";

import { useColumnSizing, useContainerWidth, useNewRows } from "./tableHooks";

import { useTablePatches } from "src/screens/connection/hooks/useTablePatches";
import { CanvasTable } from "./CanvasTable";

// ============================================================================
// Types
// ============================================================================

interface Props {
  columns: ColumnMeta[];
  totalRows: number;
  getRowAt: (rowIndex: number) => unknown[] | undefined;

  onCellChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onDeleteRow?: (rowIndex: number) => void;
  onAddRow?: () => void;
  patches?: Record<string, Record<string, any>> | null;
  newRowKeys?: string[];
  deletedRows?: Set<number>;
  rowsVersion: number;
}

// ============================================================================
// Main
// ============================================================================

const DATA_KEY: DataKey = "data";

export function TableData({
  columns,
  totalRows,
  getRowAt,
  patches,
  onCellChange,
  onDeleteRow,
  onAddRow,
  newRowKeys = EMPTY_ARRAY,
  deletedRows = EMPTY_SET,
  rowsVersion = 0,
}: Props) {
  const baseLen = Math.max(0, totalRows || 0);

  // --------------------------------------------------------------------------
  // Columns
  // --------------------------------------------------------------------------

  const {
    columnsKey,
    widthByName,
    totalWidth: columnsWidth,
  } = useColumnSizing(columns);

  const { containerRef, containerWidth } = useContainerWidth();

  const safeContainerWidth = Math.max(1, containerWidth || 0);
  const emptyColumnWidth = Math.max(0, safeContainerWidth - columnsWidth);

  // --------------------------------------------------------------------------
  // Data / patches
  // --------------------------------------------------------------------------

  const newRows = useNewRows(patches, newRowKeys, columns, columnsKey);

  const patchHelpers = useTablePatches({
    patches,
    newRowKeys,
    deletedRows,
    editedDataLength: baseLen,
  });

  const totalDataLength = baseLen + newRows.length;

  // Unified row accessor (base + newRows)
  const getRowArray = useCallback(
    (idx: number): unknown[] | undefined => {
      void rowsVersion;

      if (idx < 0) return undefined;

      if (idx < baseLen) {
        return getRowAt(idx);
      }

      const j = idx - baseLen;
      if (j >= 0 && j < newRows.length) {
        const obj = newRows[j]?.row ?? EMPTY_OBJECT;
        const out = new Array(columns.length);
        for (let c = 0; c < columns.length; c++) {
          const name = columns[c]!.name;
          out[c] = (obj as any)?.[name]?.v ?? (obj as any)?.[name] ?? null;
        }
        return out;
      }

      return undefined;
    },
    [baseLen, getRowAt, newRows, columns, rowsVersion]
  );

  // --------------------------------------------------------------------------
  // Selection / editing state (canvas-style)
  // --------------------------------------------------------------------------

  const [selected, setSelected] = useState<{
    rowIdx: number;
    colIdx: number;
  } | null>(null);
  const [editing, setEditing] = useState<{
    rowIdx: number;
    colIdx: number;
  } | null>(null);

  // --------------------------------------------------------------------------
  // Commit edit (IMPORTANT glue)
  // --------------------------------------------------------------------------

  const handleCommitEdit = useCallback(
    (cell: { rowIdx: number; colIdx: number }, newValue: string) => {
      const { rowIdx, colIdx } = cell;
      if (rowIdx < 0) return;

      const col = columns[colIdx];
      if (!col) return;

      const colName = col.name;

      const rowArr = getRowArray(rowIdx);
      const originalValue = (rowArr as any)?.[colIdx] ?? null;

      const patchedValue = patchHelpers.getPatchedValue(
        rowIdx,
        colName,
        originalValue,
        newRows
      );

      const prev = cellToString(patchedValue).trim();
      const next = (newValue ?? "").trim();

      const isNewRow = patchHelpers.isNewRow(rowIdx);

      if (!isNewRow && prev === next) return;

      // Update local cache (optional hook)
      // updateData(rowIdx, colName, newValue);

      const changeData: Record<string, any> = { [colName]: newValue };

      if (isNewRow) {
        const rowKey = patchHelpers.getRowKey(rowIdx, newRows);
        changeData.__rowKey = rowKey;
      }

      onCellChange?.(
        isNewRow ? "create" : "update",
        DATA_KEY,
        isNewRow ? -1 : rowIdx,
        changeData
      );
    },
    [columns, getRowArray, patchHelpers, newRows, onCellChange]
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div ref={containerRef} class="h-full w-full">
      <CanvasTable
        columns={columns}
        totalRows={totalDataLength}
        getRowAt={getRowArray}
        widthByName={widthByName}
        emptyColumnWidth={emptyColumnWidth}
        selected={selected}
        editing={editing}
        onSelect={(rowIdx, colIdx) => {
          setSelected({ rowIdx, colIdx });
          setEditing(null);
        }}
        onStartEdit={(cell) => {
          setEditing(cell);
          setSelected(cell);
        }}
        onAddRow={onAddRow}
        onDeleteRow={onDeleteRow}
        onCommitEdit={handleCommitEdit}
        onExitEdit={() => setEditing(null)}
        dataVersion={rowsVersion ?? 0}
      />
    </div>
  );
}
