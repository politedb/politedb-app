import { useMemo, useState, useEffect, useCallback } from "preact/hooks";
import { TableVirtuoso } from "react-virtuoso";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cn } from "src/utils/cn";
import { useNormalizeTableData } from "src/hooks/useNormalizeTableData";
import { useFillViewportTable } from "src/hooks/useFillViewportTable";
import { useTablePatches } from "src/screens/connection/hooks/useTablePatches";
import { useTableRowSelection } from "src/screens/connection/hooks/useTableRowSelection";
import { TableCell } from "./TableCell";
import type { DataAction, DataKey } from "src/stores/connection";

import {
  type EditingCell,
  type NewRowData,
  EMPTY_ARRAY,
  EMPTY_SET,
  EMPTY_OBJECT,
  DEFAULT_COL_WIDTH,
  VIRTUOSO_OVERSCAN,
  VIRTUOSO_VIEWPORT_INCREASE,
  getWidthStyle,
  measureAutoWidthForColumn,
} from "./tableUtils";

import {
  useColumnSizing,
  useColumnResize,
  useContainerWidth,
  useNewRows,
  useMergedRefs,
} from "./tableHooks";
import { memo } from "preact/compat";

// ============================================================================
// Types
// ============================================================================

interface Props {
  columns: ColumnMeta[];
  data: any[];
  onCellChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onDeleteRow?: (rowIndex: number) => void;
  patches?: Record<string, Record<string, any>> | null;
  newRowKeys?: string[];
  deletedRows?: Set<number>;
}

interface RowContext {
  columns: ColumnMeta[];
  widthByName: Record<string, number>;
  emptyColumnWidth: number;
  tableData: any[];
  allData: any[];
  newRows: NewRowData[];
  editingCell: EditingCell | null;
  isRowPatched: (idx: number, newRows: NewRowData[]) => boolean;
  isNewRow: (idx: number) => boolean;
  isRowDeleted: (idx: number) => boolean;
  isCellPatched: (idx: number, col: string, newRows: NewRowData[]) => boolean;
  getPatchedValue: (
    idx: number,
    col: string,
    fallback: any,
    newRows: NewRowData[]
  ) => any;
  getRowKey: (idx: number, newRows: NewRowData[]) => string;
  onCellChange?: Props["onCellChange"];
  setEditingCell: (cell: EditingCell | null) => void;
  updateData: (rowIndex: number, columnId: string, value: any) => void;
}

// ============================================================================
// Memoized Sub-components
// ============================================================================

interface HeaderCellProps {
  col: ColumnMeta;
  width: number;
  onResizePointerDown: (colName: string, e: PointerEvent) => void;
  onResizePointerMove: (e: PointerEvent) => void;
  onResizePointerUp: (e: PointerEvent) => void;
  onAutoFit: (colName: string) => void;
  onReset: (col: ColumnMeta) => void;
}

const HeaderCell = memo(function HeaderCell({
  col,
  width,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onAutoFit,
  onReset,
}: HeaderCellProps) {
  const handlePointerDown = useCallback(
    (e: any) => onResizePointerDown(col.name, e as PointerEvent),
    [col.name, onResizePointerDown]
  );

  const handleDblClick = useCallback(
    (e: any) => {
      if ((e as MouseEvent).altKey) onReset(col);
      else onAutoFit(col.name);
    },
    [col, onAutoFit, onReset]
  );

  return (
    <th
      data-col={col.name}
      class="relative border-r border-neutral-200 bg-neutral-50 p-2 text-left text-xs font-semibold whitespace-nowrap text-neutral-700 shadow-sm select-none"
      style={getWidthStyle(width)}
    >
      {col.name}
      <div
        class="absolute top-0 right-0 h-full w-1.5 cursor-col-resize"
        onPointerDown={handlePointerDown}
        onPointerMove={onResizePointerMove as any}
        onPointerUp={onResizePointerUp as any}
        onDblClick={handleDblClick}
      />
    </th>
  );
});

const EmptyHeaderCell = memo(function EmptyHeaderCell({
  width,
}: {
  width: number;
}) {
  return (
    <th
      class="border-r border-neutral-200 bg-neutral-50 p-2 text-left text-xs font-semibold whitespace-nowrap text-neutral-700 shadow-sm select-none"
      style={getWidthStyle(width)}
    />
  );
});

// ============================================================================
// Cell Components
// ============================================================================

interface DataCellProps {
  rowIdx: number;
  colIdx: number;
  col: ColumnMeta;
  width: number;
  ctx: RowContext;
}

const DataCell = memo(function DataCell({
  rowIdx,
  colIdx,
  col,
  width,
  ctx,
}: DataCellProps) {
  const colName = col.name;
  const isSelecting = ctx.editingCell?.rowIdx === rowIdx;
  const isEditing = isSelecting && ctx.editingCell?.colIdx === colIdx;
  const cellPatched = ctx.isCellPatched(rowIdx, colName, ctx.newRows);
  const rowIsNew = ctx.isNewRow(rowIdx);
  const rowDeleted = ctx.isRowDeleted(rowIdx);
  const rowPatched = ctx.isRowPatched(rowIdx, ctx.newRows);

  const originalValue =
    rowIdx < ctx.tableData.length ? ctx.tableData[rowIdx]?.[colName] : null;

  const fallback =
    rowIdx < ctx.allData.length ? ctx.allData[rowIdx]?.[colName]?.v : null;

  const value = ctx.getPatchedValue(rowIdx, colName, fallback, ctx.newRows);
  const rowKey = ctx.getRowKey(rowIdx, ctx.newRows);

  const cellClass = cn(
    "max-w-52 min-w-20 border border-neutral-200 text-sm text-neutral-900",
    "overflow-hidden text-ellipsis whitespace-nowrap",
    isSelecting ? "bg-blue-200!" : "hover:bg-blue-50",
    rowIsNew && !isSelecting && "bg-green-100",
    rowDeleted && !isSelecting && "bg-red-50/20 opacity-50",
    rowPatched && !isSelecting && !rowIsNew && !rowDeleted && "bg-amber-50/40",
    cellPatched && !isSelecting && "ring-1 ring-amber-200",
    isEditing && "outline-2 -outline-offset-2 outline-blue-500"
  );

  return (
    <td
      data-row={rowIdx}
      data-col={colName}
      tabIndex={0}
      style={getWidthStyle(width)}
      class={cellClass}
    >
      <TableCell
        rowIndex={rowIdx}
        colIndex={colIdx}
        colName={colName}
        originalValue={originalValue}
        value={value}
        isPatched={cellPatched}
        isNewRow={rowIsNew}
        rowKey={rowKey}
        isDeleted={rowDeleted}
        onCellChange={ctx.onCellChange}
        setEditingCell={ctx.setEditingCell}
        updateData={ctx.updateData}
      />
    </td>
  );
});

// ============================================================================
// Row Components
// ============================================================================

interface DataRowProps {
  rowIdx: number;
  ctx: RowContext;
}

const DataRow = memo(function DataRow({ rowIdx, ctx }: DataRowProps) {
  const isSelecting = ctx.editingCell?.rowIdx === rowIdx;
  const rowIsNew = ctx.isNewRow(rowIdx);
  const rowDeleted = ctx.isRowDeleted(rowIdx);
  const rowPatched = ctx.isRowPatched(rowIdx, ctx.newRows);

  const emptyColClass = cn(
    "border border-neutral-200 text-sm text-neutral-900",
    isSelecting ? "bg-blue-200!" : "hover:bg-blue-50",
    rowIsNew && !isSelecting && "bg-green-100",
    rowDeleted && !isSelecting && "bg-red-50/20 opacity-50",
    rowPatched && !isSelecting && !rowIsNew && !rowDeleted && "bg-amber-50/40"
  );

  return (
    <>
      {ctx.columns.map((col, colIdx) => (
        <DataCell
          key={col.name}
          rowIdx={rowIdx}
          colIdx={colIdx}
          col={col}
          width={ctx.widthByName[col.name] ?? DEFAULT_COL_WIDTH}
          ctx={ctx}
        />
      ))}
      {ctx.emptyColumnWidth > 0 && (
        <td
          data-row={rowIdx}
          style={getWidthStyle(ctx.emptyColumnWidth)}
          class={emptyColClass}
        />
      )}
    </>
  );
});

interface EmptyRowProps {
  columns: ColumnMeta[];
  widthByName: Record<string, number>;
  emptyColumnWidth: number;
}

const EmptyRow = memo(function EmptyRow({
  columns,
  widthByName,
  emptyColumnWidth,
}: EmptyRowProps) {
  return (
    <>
      {columns.map((col) => (
        <td
          key={col.name}
          data-col={col.name}
          class="h-7 border border-neutral-200 px-1"
          style={getWidthStyle(widthByName[col.name] ?? DEFAULT_COL_WIDTH)}
        />
      ))}
      {emptyColumnWidth > 0 && (
        <td
          class="h-7 border border-neutral-200 px-1"
          style={getWidthStyle(emptyColumnWidth)}
        />
      )}
    </>
  );
});

// ============================================================================
// Main Component
// ============================================================================

export function TableData({
  columns,
  data,
  patches,
  onCellChange,
  onDeleteRow,
  newRowKeys = EMPTY_ARRAY,
  deletedRows = EMPTY_SET,
}: Props) {
  const { tableData } = useNormalizeTableData(columns, data);

  const [editedData, setEditedData] = useState<any[]>(tableData);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);

  // Sync editedData with tableData
  useEffect(() => {
    setEditedData(tableData);
  }, [tableData]);

  // Column sizing
  const {
    columnsKey,
    setColumnSizes,
    widthByName,
    totalWidth: columnsWidth,
    resetColumnWidth,
  } = useColumnSizing(columns);

  // Column resize handlers
  const resize = useColumnResize(widthByName, setColumnSizes);

  // Container sizing
  const { containerRef, containerWidth } = useContainerWidth();

  // New rows from patches
  const newRows = useNewRows(patches, newRowKeys, columns, columnsKey);

  // Combined data
  const allData = useMemo(
    () =>
      newRows.length === 0
        ? editedData
        : [...editedData, ...newRows.map((nr) => nr.row)],
    [editedData, newRows]
  );

  // Patches helpers
  const patchHelpers = useTablePatches({
    patches,
    newRowKeys,
    deletedRows,
    editedDataLength: editedData.length,
  });

  // Row selection
  const { handleRowSelect, keyboardContainerRef } = useTableRowSelection({
    onDeleteRow,
    deletedRows,
    isNewRow: patchHelpers.isNewRow,
  });

  // Viewport fill
  const { emptyRowsCount, containerRef: viewportContainerRef } =
    useFillViewportTable({
      dataLength: allData.length,
      fillViewport: true,
      headerHeight: 40,
    });

  // Layout calculations
  const emptyColumnWidth = Math.max(0, containerWidth - columnsWidth);
  const tablePixelWidth = Math.max(
    columnsWidth + emptyColumnWidth,
    containerWidth || 100
  );

  // Auto-fit column
  const autoFitColumn = useCallback(
    (colName: string) => {
      const el = containerRef.current;
      if (!el) return;

      requestAnimationFrame(() => {
        const next = measureAutoWidthForColumn(el, colName);
        setColumnSizes((prev) =>
          prev[colName] === next ? prev : { ...prev, [colName]: next }
        );
      });
    },
    [setColumnSizes]
  );

  // Update cell data
  const updateData = useCallback(
    (rowIndex: number, columnId: string, value: any) => {
      setEditedData((prev) => {
        if (rowIndex >= prev.length) return prev;
        const target = prev[rowIndex];
        if (!target || target[columnId]?.v === value) return prev;

        const next = prev.slice();
        next[rowIndex] = {
          ...target,
          [columnId]: { ...(target[columnId] ?? EMPTY_OBJECT), v: value },
        };
        return next;
      });
    },
    []
  );

  // Event delegation for cell clicks
  const onTableMouseDown = useCallback(
    (e: MouseEvent) => {
      const td = (e.target as HTMLElement)?.closest?.("td[data-row]");
      if (!td) return;

      const rowIdx = Number((td as HTMLElement).dataset.row);
      if (Number.isFinite(rowIdx)) {
        e.stopPropagation();
        handleRowSelect(rowIdx);
      }
    },
    [handleRowSelect]
  );

  // Merge refs
  const mergedContainerRef = useMergedRefs(
    containerRef,
    keyboardContainerRef,
    viewportContainerRef
  );

  // Row context
  const rowContext = useMemo<RowContext>(
    () => ({
      columns,
      widthByName,
      emptyColumnWidth,
      tableData,
      allData,
      newRows,
      editingCell,
      ...patchHelpers,
      onCellChange,
      setEditingCell,
      updateData,
    }),
    [
      columnsKey,
      widthByName,
      emptyColumnWidth,
      tableData,
      allData,
      newRows,
      editingCell,
      patchHelpers,
      onCellChange,
      updateData,
    ]
  );

  // Render header
  const renderHeader = useCallback(
    () => (
      <tr>
        {columns.map((col) => (
          <HeaderCell
            key={col.name}
            col={col}
            width={widthByName[col.name] ?? DEFAULT_COL_WIDTH}
            onResizePointerDown={resize.onPointerDown}
            onResizePointerMove={resize.onPointerMove}
            onResizePointerUp={resize.onPointerUp}
            onAutoFit={autoFitColumn}
            onReset={resetColumnWidth}
          />
        ))}
        {emptyColumnWidth > 0 && <EmptyHeaderCell width={emptyColumnWidth} />}
      </tr>
    ),
    [
      columnsKey,
      widthByName,
      emptyColumnWidth,
      resize,
      autoFitColumn,
      resetColumnWidth,
    ]
  );

  // Render row
  const renderRow = useCallback(
    (itemIndex: number) => {
      if (itemIndex >= allData.length) {
        return (
          <EmptyRow
            columns={columns}
            widthByName={widthByName}
            emptyColumnWidth={emptyColumnWidth}
          />
        );
      }
      return <DataRow rowIdx={itemIndex} ctx={rowContext} />;
    },
    [allData.length, columns, widthByName, emptyColumnWidth, rowContext]
  );

  // Virtuoso style
  const virtuosoStyle = useMemo(
    () => ({
      height: "100%",
      width: `${tablePixelWidth}px`,
      minWidth: "100%",
      overflowY: (emptyRowsCount > 0 ? "hidden" : "auto") as "hidden" | "auto",
    }),
    [tablePixelWidth, emptyRowsCount]
  );

  const totalCount = allData.length + emptyRowsCount;

  return (
    <div
      ref={mergedContainerRef}
      class="flex h-full flex-col overflow-hidden bg-white"
      tabIndex={0}
      onMouseDown={onTableMouseDown as any}
    >
      <div class="flex-1 overflow-x-auto overflow-y-hidden border-t border-neutral-200">
        <TableVirtuoso
          style={virtuosoStyle}
          totalCount={totalCount}
          fixedHeaderContent={renderHeader}
          itemContent={renderRow}
          overscan={VIRTUOSO_OVERSCAN}
          increaseViewportBy={VIRTUOSO_VIEWPORT_INCREASE}
        />
      </div>
    </div>
  );
}
