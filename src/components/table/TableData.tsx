import { useMemo, useState, useEffect, useCallback } from "preact/hooks";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  Row,
} from "@tanstack/react-table";
import { TableVirtuoso } from "react-virtuoso";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cn } from "src/utils/cn";
import { useNormalizeTableData } from "src/hooks/useNormalizeTableData";
import { useFillViewportTable } from "src/hooks/useFillViewportTable";
import { TableCell } from "./TableCell";
import { DataAction, DataKey } from "src/stores/connection";

export type EditingCell = {
  rowIdx: number;
  colName: string;
  colIdx: number;
};

interface Props {
  columns: ColumnMeta[];
  data: any[];
  onCellChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;

  // rowIndexStr -> colName -> value
  patches?: Record<string, Record<string, any>> | null;

  // Array of row keys that represent new rows (for create action)
  newRowKeys?: string[];
}

function hasOwn(obj: any, key: string) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function TableData({
  columns,
  data,
  patches,
  onCellChange,
  newRowKeys = [],
}: Props) {
  // Normalize data on mount and when it changes
  const { tableData } = useNormalizeTableData(columns, data);

  const [editedData, setEditedData] = useState<any[]>(tableData);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);

  // Update editedData when normalized data changes
  useEffect(() => {
    setEditedData(tableData);
  }, [tableData]);

  // Create virtual rows for new rows from create patches
  const newRows = useMemo(() => {
    if (!patches || newRowKeys.length === 0) return [];

    const rows: any[] = [];
    for (const rowKey of newRowKeys) {
      const patchData = patches[rowKey];
      if (!patchData) continue;

      // Create a normalized row object for the new row
      const row: any = {};
      columns.forEach((col) => {
        const value = patchData[col.name];
        row[col.name] = {
          v: value !== undefined ? value : null,
          t:
            value === null
              ? "Null"
              : typeof value === "string"
                ? "String"
                : "Number",
        };
      });
      rows.push({ row, rowKey, isNew: true });
    }
    return rows;
  }, [patches, newRowKeys, columns]);

  // Combine original data with new rows
  const allData = useMemo(() => {
    return [...editedData, ...newRows.map((nr) => nr.row)];
  }, [editedData, newRows]);

  // Get row key for a given row index (handles both numeric indices and new row string keys)
  const getRowKey = useCallback(
    (rowIndex: number): string => {
      // Check if this is a new row (index >= editedData.length)
      if (rowIndex >= editedData.length) {
        const newRowIndex = rowIndex - editedData.length;
        const newRow = newRows[newRowIndex];
        return newRow?.rowKey || String(rowIndex);
      }
      return String(rowIndex);
    },
    [editedData.length, newRows]
  );

  // Check if a row is a new row (for create action)
  const isNewRow = useCallback(
    (rowIndex: number): boolean => {
      return rowIndex >= editedData.length;
    },
    [editedData.length]
  );

  // For update cell rendering, prefer patched value over original
  const getPatchedValue = useCallback(
    (rowIndex: number, colName: string, fallback: any) => {
      const rowKey = getRowKey(rowIndex);
      const rowPatch = patches?.[rowKey];
      if (!rowPatch) return fallback;
      if (hasOwn(rowPatch, colName)) return rowPatch[colName];
      return fallback;
    },
    [patches, getRowKey]
  );

  const isCellPatched = useCallback(
    (rowIndex: number, colName: string) => {
      const rowKey = getRowKey(rowIndex);
      const rowPatch = patches?.[rowKey];
      return !!rowPatch && hasOwn(rowPatch, colName);
    },
    [patches, getRowKey]
  );

  const isRowPatched = useCallback(
    (rowIndex: number) => {
      const rowKey = getRowKey(rowIndex);
      const rowPatch = patches?.[rowKey];
      return !!rowPatch && Object.keys(rowPatch).length > 0;
    },
    [patches, getRowKey]
  );

  // Define table columns
  const tableColumns = useMemo<ColumnDef<any>[]>(
    () =>
      columns.map((col) => ({
        id: col.name,
        accessorFn: (row) => row[col.name]?.v,
        header: col.name,
        cell: ({ cell, row, table }) => {
          const rowIndex = row.index;
          const colName = cell.column.id;
          const rowIsNew = isNewRow(rowIndex);
          const rowKey = getRowKey(rowIndex);

          const originalValue =
            rowIndex < tableData.length ? tableData[rowIndex]?.[colName] : null;

          // prefer patch -> editedData -> original(tableData)
          const fallback =
            rowIndex < allData.length ? allData[rowIndex]?.[colName]?.v : null;
          const value = getPatchedValue(rowIndex, colName, fallback);

          const patched = isCellPatched(rowIndex, colName);

          return (
            <TableCell
              cell={cell}
              row={row}
              table={table}
              colName={colName}
              originalValue={originalValue}
              value={value}
              isPatched={patched}
              isNewRow={rowIsNew}
              rowKey={rowKey}
              onCellChange={onCellChange}
              setEditingCell={setEditingCell}
            />
          );
        },
      })),
    [
      columns,
      tableData,
      allData,
      onCellChange,
      getPatchedValue,
      isCellPatched,
      setEditingCell,
      isNewRow,
      getRowKey,
    ]
  );

  const table = useReactTable({
    data: allData,
    columns: tableColumns,
    defaultColumn: {
      minSize: 60,
      size: 80,
      maxSize: 800,
    },
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    meta: {
      updateData: (rowIndex: number, columnId: string, value: any) => {
        // Check if this is a new row
        if (rowIndex < editedData.length) {
          // Update existing row
          setEditedData((prev) =>
            prev.map((row, index) => {
              if (index === rowIndex) {
                return {
                  ...prev[rowIndex]!,
                  [columnId]: { ...prev[rowIndex][columnId]!, v: value },
                };
              }
              return row;
            })
          );
        }
      },
    },
  });

  // Calculate empty rows to fill viewport
  const { emptyRowsCount, containerRef } = useFillViewportTable({
    dataLength: allData.length,
    fillViewport: true,
    headerHeight: 40,
  });

  const columnSizeVars = useMemo(() => {
    const headers = table.getFlatHeaders();
    const colSizes: { [key: string]: number } = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i]!;
      colSizes[`--header-${header.id}-size`] = header.getSize();
      colSizes[`--col-${header.column.id}-size`] = header.column.getSize();
    }
    return colSizes;
  }, [table.getState().columnSizingInfo, table.getState().columnSizing]);

  const tableRows = useMemo(() => table.getRowModel().rows ?? [], [allData]);

  // Create empty rows for viewport filling
  const emptyRows = useMemo(() => {
    if (emptyRowsCount === 0) return [];
    return Array.from({ length: emptyRowsCount }, (_, idx) => ({
      id: `empty-${idx}`,
      index: allData.length + idx,
      original: {},
    }));
  }, [emptyRowsCount, allData.length]);

  const allRows = useMemo(
    () => [...tableRows, ...emptyRows],
    [tableRows, emptyRows]
  );

  const renderHeader = useCallback(() => {
    return (
      <tr>
        {table.getHeaderGroups()[0]?.headers.map((header) => (
          <th
            key={header.id}
            class={cn(
              "relative border-r border-neutral-200 bg-neutral-50 p-2 select-none",
              "text-left text-xs font-semibold whitespace-nowrap text-neutral-700 shadow-sm"
            )}
            style={{ width: `calc(var(--header-${header?.id}-size) * 1px)` }}
          >
            {header.isPlaceholder
              ? null
              : flexRender(header.column.columnDef.header, header.getContext())}
            {header.column.getCanResize() && (
              <div
                onMouseDown={header.getResizeHandler()}
                onTouchStart={header.getResizeHandler()}
                onDblClick={() => header.column.resetSize()}
                className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize"
              />
            )}
          </th>
        ))}
      </tr>
    );
  }, [table]);

  const renderRow = useCallback(
    (rowIndex: number, row: Row<any> | any) => {
      const isEmptyRow = row.id?.startsWith("empty-");
      const actualRowIndex = isEmptyRow ? row.index : rowIndex;
      const rowPatched = !isEmptyRow && isRowPatched(actualRowIndex);

      if (isEmptyRow) {
        // Render empty row
        return table
          .getHeaderGroups()[0]
          ?.headers.map((header) => (
            <td
              key={header.id}
              class={cn("h-[28px] border border-neutral-200 px-1")}
              style={{ width: `calc(var(--col-${header.id}-size) * 1px)` }}
            />
          ));
      }

      const rowIsNew = isNewRow(actualRowIndex);
      const isSelectingRow = editingCell?.rowIdx === actualRowIndex;
      console.log(
        "isSelectingRow",
        editingCell?.rowIdx,
        actualRowIndex,
        isSelectingRow
      );

      return row.getVisibleCells().map((cell: any, colIndex: number) => {
        const isEditing = isSelectingRow && editingCell?.colIdx === colIndex;

        const colName = cell.column.id;
        const cellPatched = isCellPatched(actualRowIndex, colName);

        return (
          <td
            key={cell.id}
            tabIndex={0}
            style={{ width: `calc(var(--col-${cell.column.id}-size) * 1px)` }}
            class={cn(
              "max-w-52 min-w-20 border border-neutral-200 text-sm text-neutral-900",
              isSelectingRow ? "bg-blue-200!" : "hover:bg-blue-50",
              rowIsNew && !isSelectingRow && "bg-green-50/40",
              rowPatched && !isSelectingRow && !rowIsNew && "bg-amber-50/40",
              cellPatched && !isSelectingRow && "ring-1 ring-amber-200",
              isEditing && "outline-2 -outline-offset-2 outline-blue-500"
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        );
      });
    },
    [
      editingCell?.rowIdx,
      editingCell?.colIdx,
      isCellPatched,
      isRowPatched,
      isNewRow,
      table,
    ]
  );

  return (
    <div
      ref={containerRef}
      class="flex h-full flex-col overflow-hidden bg-white"
    >
      <div class="flex-1 overflow-hidden border-t border-neutral-200">
        <TableVirtuoso
          key={`table-${allRows.length}-${columns.length}`}
          style={{
            ...columnSizeVars,
            "--table-width": `${table.getTotalSize()}px`,
            height: "100%",
            overflowY: emptyRowsCount > 0 ? "hidden" : "auto",
          }}
          data={allRows}
          fixedHeaderContent={renderHeader}
          itemContent={renderRow}
        />
      </div>
    </div>
  );
}
