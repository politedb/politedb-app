import { useCallback, useState } from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cellToString } from "src/utils/convert";
import type {
  DataAction,
  DataKey,
  SelectedRowDetail,
} from "src/stores/connection";
import { commitTableCellEdit } from "./commitTableCellEdit";
import { buildSelectedRowDetail } from "./selectedRowDetail";
import type { TableSort } from "src/hooks/queries";

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
  sortState?: TableSort | null;
  onChangeSort?: (sort: TableSort | null) => void;
  onSelectedRowDetailChange?: (detail: SelectedRowDetail | null) => void;
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
  sortState = null,
  onChangeSort,
  onSelectedRowDetailChange,
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

  const totalDataLength = totalLen + newRows.length;

  const publishSelectedRowDetail = useCallback(
    (rowIdx: number | null) => {
      if (!onSelectedRowDetailChange) return;
      if (rowIdx == null || rowIdx < 0) {
        onSelectedRowDetailChange(null);
        return;
      }
      onSelectedRowDetailChange(
        buildSelectedRowDetail(
          rowIdx,
          columns,
          getRowArray,
          patchHelpers,
          newRows
        )
      );
    },
    [onSelectedRowDetailChange, columns, getRowArray, patchHelpers, newRows]
  );

  // --------------------------------------------------------------------------
  // Commit edit (IMPORTANT glue)
  // --------------------------------------------------------------------------

  const handleCommitEdit = useCallback(
    (cell: { rowIdx: number; colIdx: number }, newValue: unknown) => {
      const { colIdx } = cell;
      const rowIdx = cell.rowIdx;
      const col = columns[colIdx];
      if (!col) return;

      commitTableCellEdit({
        rowIdx,
        columnName: col.name,
        newValue,
        columns,
        getRowArray,
        patchHelpers,
        newRows,
        dataKey: DATA_KEY,
        onCellChange,
      });
      // Data Info refresh runs from MainTableDataPane.onDataChange (fresh patches).
    },
    [columns, patchHelpers, newRows, onCellChange, getRowArray]
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
        totalRows={totalDataLength}
        getRowAt={(visibleIdx) => getRowArray(visibleIdx) ?? undefined}
        widthByName={widthByName}
        emptyColumnWidth={emptyColumnWidth}
        selected={selected}
        selectedRows={selectedRows}
        editing={editing}
        deletedRows={deletedRows}
        onSelect={(rowIdx, colIdx, multi, range) => {
          setSelected({ rowIdx, colIdx });
          setEditing(null);

          if (range && lastSelectedRow !== null) {
            const min = Math.min(lastSelectedRow, rowIdx);
            const max = Math.max(lastSelectedRow, rowIdx);
            const newSelection = new Set(selectedRows);
            for (let i = min; i <= max; i++) {
              newSelection.add(i);
            }
            setSelectedRows(newSelection);
            publishSelectedRowDetail(rowIdx);
          } else if (multi) {
            const newSelection = new Set(selectedRows);
            if (newSelection.has(rowIdx)) {
              newSelection.delete(rowIdx);
            } else {
              newSelection.add(rowIdx);
            }
            setSelectedRows(newSelection);
            setLastSelectedRow(rowIdx);
            const primary =
              newSelection.size === 1
                ? [...newSelection][0]
                : newSelection.has(rowIdx)
                  ? rowIdx
                  : null;
            publishSelectedRowDetail(
              primary ??
                (newSelection.size > 0 ? Math.min(...newSelection) : null)
            );
          } else {
            setSelectedRows(new Set([rowIdx]));
            setLastSelectedRow(rowIdx);
            publishSelectedRowDetail(rowIdx);
          }
        }}
        onStartEdit={(cell) => {
          if (readOnly) return;
          setEditing(cell);
          setSelected(cell);
          setSelectedRows(new Set([cell.rowIdx]));
          setLastSelectedRow(cell.rowIdx);
          publishSelectedRowDetail(cell.rowIdx);
        }}
        onAddRow={readOnly ? undefined : onAddRow}
        onDeleteRow={(visibleRowIdx) => {
          if (readOnly) return;
          const rowIdx = visibleRowIdx;
          if (rowIdx >= 0) {
            onDeleteRow?.(rowIdx);
          }
          setSelected(null);
          setSelectedRows(new Set());
          setEditing(null);
          publishSelectedRowDetail(null);
        }}
        onDeleteRows={(visibleRowIndices) => {
          if (readOnly) return;
          visibleRowIndices.forEach((visibleIdx) => {
            const realIdx = visibleIdx;
            if (realIdx >= 0) {
              onDeleteRow?.(realIdx);
            }
          });
          setSelected(null);
          setSelectedRows(new Set());
          setEditing(null);
          publishSelectedRowDetail(null);
        }}
        onCommitEdit={handleCommitEdit}
        onExitEdit={() => setEditing(null)}
        dataVersion={
          (rowsVersion ?? 0) * 1000 +
          (sortState ? (sortState.direction === "asc" ? 1 : 2) : 0)
        }
        isCellDirty={(visibleRowIdx, colName) => {
          const rowIdx = visibleRowIdx;
          if (rowIdx < 0) return false;
          return isCellDirty(rowIdx, colName);
        }}
        isNewRow={(visibleRowIdx) => {
          const rowIdx = visibleRowIdx;
          if (rowIdx < 0) return false;
          return isNewRow(rowIdx);
        }}
        sortState={sortState ?? undefined}
        onChangeSort={onChangeSort}
        foreignKeyMap={foreignKeyMap}
        onCellActivate={handleCellActivate}
        onClearSelection={() => {
          setSelected(null);
          setSelectedRows(new Set());
          setEditing(null);
          setLastSelectedRow(null);
          publishSelectedRowDetail(null);
        }}
      />
    </div>
  );
}
