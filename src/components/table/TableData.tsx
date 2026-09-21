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
import type { TableSort } from "src/lib/queries/sql";

import { EMPTY_ARRAY, EMPTY_SET, EMPTY_OBJECT } from "./tableUtils";

import { useColumnSizing, useContainerWidth, useNewRows } from "./tableHooks";

import { useTablePatches } from "src/screens/connection/hooks/useTablePatches";
import { CanvasTable } from "./CanvasTable";
import type { DatabaseEngine, TableForeignKey } from "src/types";

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
  onDeleteRow?: (rowIndex: number, rowKey?: string) => void;
  onAddRow?: () => void;
  onRefresh?: () => void;
  onExportCurrentPage?: () => void;
  onImportData?: () => void;
  onImportSqlDump?: () => void;
  onQuickFilter?: (colName: string, value: string) => void;
  schema?: string;
  tableName?: string;
  engine?: DatabaseEngine;
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
  onRefresh,
  onExportCurrentPage,
  onImportData,
  onImportSqlDump,
  onQuickFilter,
  schema,
  tableName,
  engine,
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
      return Object.prototype.hasOwnProperty.call(
        patches?.[rowIdx] ?? EMPTY_OBJECT,
        colName
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleDuplicateRow = useCallback(
    (rowIdx: number) => {
      if (!onCellChange || readOnly) return;
      const row = getRowArray(rowIdx);
      if (!row) return;

      const rowKey = `dup_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const data: Record<string, unknown> = { __rowKey: rowKey };
      for (let idx = 0; idx < columns.length; idx++) {
        const col = columns[idx];
        if (!col) continue;
        data[col.name] = row[idx] ?? null;
      }

      onCellChange("create", DATA_KEY, -1, data);
      setSelected({ rowIdx: totalDataLength, colIdx: 0 });
      setSelectedRows(new Set([totalDataLength]));
      setLastSelectedRow(totalDataLength);
      publishSelectedRowDetail(totalDataLength);
    },
    [
      columns,
      getRowArray,
      onCellChange,
      publishSelectedRowDetail,
      readOnly,
      totalDataLength,
    ]
  );

  const handlePasteRows = useCallback(
    (rows: unknown[][], sourceColumns?: string[]) => {
      if (!onCellChange || readOnly || rows.length === 0) return;

      const sourceIndexByName = new Map<string, number>();
      sourceColumns?.forEach((name, idx) => {
        sourceIndexByName.set(name, idx);
      });

      rows.forEach((row, rowOffset) => {
        const rowKey = `paste_${Date.now()}_${rowOffset}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const data: Record<string, unknown> = { __rowKey: rowKey };

        for (let idx = 0; idx < columns.length; idx++) {
          const col = columns[idx];
          if (!col) continue;
          const sourceIdx =
            sourceIndexByName.size > 0 ? sourceIndexByName.get(col.name) : idx;
          data[col.name] =
            sourceIdx == null || sourceIdx < 0
              ? null
              : (row[sourceIdx] ?? null);
        }

        onCellChange("create", DATA_KEY, -1, data);
      });

      const firstNewRow = totalDataLength;
      const pastedSelection = new Set<number>();
      for (let i = 0; i < rows.length; i++) {
        pastedSelection.add(firstNewRow + i);
      }
      setSelected({ rowIdx: firstNewRow, colIdx: 0 });
      setSelectedRows(pastedSelection);
      setLastSelectedRow(firstNewRow + rows.length - 1);
      publishSelectedRowDetail(firstNewRow);
    },
    [columns, onCellChange, publishSelectedRowDetail, readOnly, totalDataLength]
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
        onDuplicateRow={readOnly ? undefined : handleDuplicateRow}
        onPasteRows={readOnly ? undefined : handlePasteRows}
        onRefresh={onRefresh}
        onExportCurrentPage={onExportCurrentPage}
        onImportData={readOnly ? undefined : onImportData}
        onImportSqlDump={readOnly ? undefined : onImportSqlDump}
        onQuickFilter={onQuickFilter}
        schema={schema}
        tableName={tableName}
        engine={engine}
        onDeleteRow={(visibleRowIdx) => {
          if (readOnly) return;
          const rowIdx = visibleRowIdx;
          if (rowIdx >= 0) {
            onDeleteRow?.(
              rowIdx,
              patchHelpers.isNewRow(rowIdx)
                ? patchHelpers.getRowKey(rowIdx, newRows)
                : undefined
            );
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
              onDeleteRow?.(
                realIdx,
                patchHelpers.isNewRow(realIdx)
                  ? patchHelpers.getRowKey(realIdx, newRows)
                  : undefined
              );
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
        onSelectAllRows={() => {
          if (totalDataLength <= 0) return;
          const all = new Set<number>();
          for (let i = 0; i < totalDataLength; i++) {
            all.add(i);
          }
          setSelectedRows(all);
          setLastSelectedRow(totalDataLength - 1);
          setSelected({ rowIdx: 0, colIdx: 0 });
          setEditing(null);
          publishSelectedRowDetail(0);
        }}
      />
    </div>
  );
}
