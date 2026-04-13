import { useCallback, useMemo, useState } from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cellToString } from "src/utils/convert";
import type { DataAction, DataKey } from "src/stores/connection";

import { EMPTY_ARRAY, EMPTY_SET, EMPTY_OBJECT } from "./tableUtils";

import { useColumnSizing, useContainerWidth, useNewRows } from "./tableHooks";

import { useTablePatches } from "src/screens/connection/hooks/useTablePatches";
import { CanvasTable } from "./CanvasTable";
import { TableForeignKey } from "src/types";

// ============================================================================
// Types
// ============================================================================

interface Props {
  columns: ColumnMeta[];
  baseRows: number;
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

  foreignKeyMap?: Record<string, TableForeignKey>;

  onNavigateFk?: (args: {
    value: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
  }) => void;
  readOnly?: boolean;
}

// ============================================================================
// Main
// ============================================================================

const DATA_KEY: DataKey = "data";

export function TableData({
  columns,
  baseRows,
  totalRows,
  getRowAt,
  patches,
  onCellChange,
  onDeleteRow,
  onAddRow,
  newRowKeys = EMPTY_ARRAY,
  deletedRows = EMPTY_SET,
  rowsVersion = 0,
  foreignKeyMap,
  onNavigateFk,
  readOnly = false,
}: Props) {
  const baseLen = Math.max(0, baseRows || 0);
  const totalLen = Math.max(0, totalRows || 0);

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

  // Unified row accessor (base + newRows)
  const getRowArray = useCallback(
    (idx: number): unknown[] | undefined => {
      void rowsVersion;

      if (idx < 0) return undefined;

      if (idx < totalLen) {
        return getRowAt(idx);
      }

      const j = idx - totalLen;
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
    [totalLen, getRowAt, newRows, columns, rowsVersion]
  );

  // Check if a cell is dirty (has a patch)
  const isCellDirty = useCallback(
    (rowIdx: number, colName: string) => {
      if (!patches || patchHelpers.isNewRow(rowIdx)) return false;

      // existing row
      return !!patches?.[rowIdx]?.[colName];
    },
    [patches, patchHelpers, newRows]
  );

  // Check if a row is new
  const isNewRow = useCallback(
    (rowIdx: number) => {
      if (!patches) return false;
      return patchHelpers.isNewRow(rowIdx);
    },
    [patches, patchHelpers]
  );

  // --------------------------------------------------------------------------
  // Selection / editing state (canvas-style)
  // --------------------------------------------------------------------------

  const [selected, setSelected] = useState<{
    rowIdx: number;
    colIdx: number;
  } | null>(null);
  
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [lastSelectedRow, setLastSelectedRow] = useState<number | null>(null);
  
  const [editing, setEditing] = useState<{
    rowIdx: number;
    colIdx: number;
  } | null>(null);

  // --------------------------------------------------------------------------
  // Client-side sorting (per page)
  // --------------------------------------------------------------------------

  const [sortState, setSortState] = useState<{
    colName: string;
    direction: "asc" | "desc";
  } | null>(null);

  const totalDataLength = totalLen + newRows.length;

  const rowOrder = useMemo(() => {
    const n = totalDataLength;
    const order = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;

    if (!sortState) return order;

    const colIndex = columns.findIndex((c) => c.name === sortState.colName);
    if (colIndex === -1) return order;

    const dir = sortState.direction === "asc" ? 1 : -1;

    order.sort((ai, bi) => {
      const a = getRowArray(ai);
      const b = getRowArray(bi);

      const va = a ? (a as any)[colIndex] : null;
      const vb = b ? (b as any)[colIndex] : null;

      const sa = (cellToString(va) ?? "").toString();
      const sb = (cellToString(vb) ?? "").toString();

      if (sa < sb) return -1 * dir;
      if (sa > sb) return 1 * dir;
      return 0;
    });

    return order;
  }, [totalDataLength, sortState, columns, getRowArray]);

  const visibleDeletedRows = useMemo(() => {
    if (!deletedRows || deletedRows.size === 0) return deletedRows;
    const mapped = new Set<number>();
    for (let i = 0; i < rowOrder.length; i++) {
      const real = rowOrder[i]!;
      if (deletedRows.has(real)) mapped.add(i);
    }
    return mapped;
  }, [deletedRows, rowOrder]);

  // --------------------------------------------------------------------------
  // Commit edit (IMPORTANT glue)
  // --------------------------------------------------------------------------

  const handleCommitEdit = useCallback(
    (cell: { rowIdx: number; colIdx: number }, newValue: string) => {
      const { colIdx } = cell;
      const rowIdx = rowOrder[cell.rowIdx] ?? -1;
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

      const prev = (cellToString(patchedValue) ?? "").trim();
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
    [columns, patchHelpers, newRows, rowOrder, onCellChange, getRowArray]
  );

  const handleCellActivate = useCallback(
    (cell: { rowIdx: number; colIdx: number }): boolean => {
      if (!foreignKeyMap || !onNavigateFk) return false;

      const col = columns[cell.colIdx];
      if (!col) return false;

      const fk = foreignKeyMap[col.name];
      if (!fk) return false;

      const rowArr = getRowArray(cell.rowIdx);
      if (!rowArr) return false;

      const raw = rowArr[cell.colIdx];
      const v = cellToString(raw);
      const value = (v ?? "").toString().trim();
      if (!value) return false;

      onNavigateFk({
        value,
        refSchema: fk.schema,
        refTable: fk.table,
        refColumn: fk.column,
      });

      return true;
    },
    [columns, foreignKeyMap, getRowArray, onNavigateFk]
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div ref={containerRef} class="h-full min-h-0 w-full">
      <CanvasTable
        columns={columns}
        totalRows={rowOrder.length}
        getRowAt={(visibleIdx) =>
          getRowArray(rowOrder[visibleIdx] ?? -1) ?? undefined
        }
        widthByName={widthByName}
        emptyColumnWidth={emptyColumnWidth}
        selected={selected}
        selectedRows={selectedRows}
        editing={editing}
        deletedRows={visibleDeletedRows}
        onSelect={(rowIdx, colIdx, multi, range) => {
          setSelected({ rowIdx, colIdx });
          setEditing(null);
          
          if (range && lastSelectedRow !== null) {
            // Shift click
            const min = Math.min(lastSelectedRow, rowIdx);
            const max = Math.max(lastSelectedRow, rowIdx);
            const newSelection = new Set(selectedRows);
            for (let i = min; i <= max; i++) {
               newSelection.add(i);
            }
            setSelectedRows(newSelection);
          } else if (multi) {
            // Ctrl/Cmd click
            const newSelection = new Set(selectedRows);
            if (newSelection.has(rowIdx)) {
              newSelection.delete(rowIdx);
            } else {
              newSelection.add(rowIdx);
            }
            setSelectedRows(newSelection);
            setLastSelectedRow(rowIdx);
          } else {
            // Normal click
            setSelectedRows(new Set([rowIdx]));
            setLastSelectedRow(rowIdx);
          }
        }}
        onStartEdit={(cell) => {
          if (readOnly) return;
          setEditing(cell);
          setSelected(cell);
          setSelectedRows(new Set([cell.rowIdx]));
          setLastSelectedRow(cell.rowIdx);
        }}
        onAddRow={readOnly ? undefined : onAddRow}
        onDeleteRow={(visibleRowIdx) => {
          if (readOnly) return;
          const rowIdx = rowOrder[visibleRowIdx] ?? -1;
          if (rowIdx >= 0) {
            onDeleteRow?.(rowIdx);
          }
          setSelected(null);
          setSelectedRows(new Set());
          setEditing(null);
        }}
        onDeleteRows={(visibleRowIndices) => {
          if (readOnly) return;
          visibleRowIndices.forEach(visibleIdx => {
             const realIdx = rowOrder[visibleIdx] ?? -1;
             if (realIdx >= 0) {
               onDeleteRow?.(realIdx);
             }
          });
          setSelected(null);
          setSelectedRows(new Set());
          setEditing(null);
        }}
        onCommitEdit={handleCommitEdit}
        onExitEdit={() => setEditing(null)}
        dataVersion={
          (rowsVersion ?? 0) * 1000 +
          (sortState ? (sortState.direction === "asc" ? 1 : 2) : 0)
        }
        isCellDirty={(visibleRowIdx, colName) => {
          const rowIdx = rowOrder[visibleRowIdx] ?? -1;
          if (rowIdx < 0) return false;
          return isCellDirty(rowIdx, colName);
        }}
        isNewRow={(visibleRowIdx) => {
          const rowIdx = rowOrder[visibleRowIdx] ?? -1;
          if (rowIdx < 0) return false;
          return isNewRow(rowIdx);
        }}
        sortState={sortState ?? undefined}
        onChangeSort={setSortState}
        foreignKeyMap={foreignKeyMap}
        onCellActivate={handleCellActivate}
        onClearSelection={() => {
          setSelected(null);
          setSelectedRows(new Set());
          setEditing(null);
          setLastSelectedRow(null);
        }}
      />
    </div>
  );
}
