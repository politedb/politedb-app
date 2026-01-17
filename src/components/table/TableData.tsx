import { useMemo, useState, useEffect, useCallback } from "preact/hooks";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  Row,
} from "@tanstack/react-table";
import { TableVirtuoso } from "react-virtuoso";
import type { ColumnMeta } from "../../lib/tauri/types";
import { cn } from "../../utils/cn";
import { useNormalizeTableData } from "../../hooks/useNormalizeTableData";
import { TableCell } from "./TableCell";
import { TablePagination } from "./TablePagination";

export type EditingCell = {
  rowIdx: number;
  colName: string;
  colIdx: number;
};

interface Props {
  limit: number;
  offset: number;
  columns: ColumnMeta[];
  data: any[];
  totalRows: number;
  onPageChange: (limit: number, offset: number) => void;
  onCellChange?: (rowIndex: number, columnIndex: number, value: any) => void;

  // rowIndexStr -> colName -> value
  patches?: Record<string, Record<string, any>> | null;
}

function hasOwn(obj: any, key: string) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function TableData({
  limit,
  offset,
  columns,
  data,
  totalRows,
  patches,
  onCellChange,
  onPageChange,
}: Props) {
  // Normalize data on mount and when it changes
  const { tableData } = useNormalizeTableData(columns, data);

  const [editedData, setEditedData] = useState<any[]>(tableData);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);

  // Update editedData when normalized data changes
  useEffect(() => {
    setEditedData(tableData);
  }, [tableData]);

  // For update cell rendering, prefer patched value over original
  const getPatchedValue = useCallback(
    (rowIndex: number, colName: string, fallback: any) => {
      const rowPatch = patches?.[String(rowIndex)];
      if (!rowPatch) return fallback;
      if (hasOwn(rowPatch, colName)) return rowPatch[colName];
      return fallback;
    },
    [patches]
  );

  const isCellPatched = useCallback(
    (rowIndex: number, colName: string) => {
      const rowPatch = patches?.[String(rowIndex)];
      return !!rowPatch && hasOwn(rowPatch, colName);
    },
    [patches]
  );

  const isRowPatched = useCallback(
    (rowIndex: number) => {
      const rowPatch = patches?.[String(rowIndex)];
      return !!rowPatch && Object.keys(rowPatch).length > 0;
    },
    [patches]
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

          const originalValue = tableData[rowIndex]?.[colName];

          // prefer patch -> editedData -> original(tableData)
          const fallback = editedData[rowIndex]?.[colName]?.v;
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
              onCellChange={onCellChange}
              setEditingCell={setEditingCell}
            />
          );
        },
      })),
    [
      columns,
      tableData,
      editedData,
      onCellChange,
      getPatchedValue,
      isCellPatched,
      setEditingCell,
    ]
  );

  // Calculate pagination
  const pagination = useMemo(() => {
    const startIndex = offset;
    const endIndex = startIndex + limit;

    return {
      totalRows,
      totalPages: Math.ceil(totalRows / limit),
      startIndex,
      endIndex,
    };
  }, [totalRows, limit, offset]);

  const table = useReactTable({
    data: editedData,
    columns: tableColumns,
    defaultColumn: {
      minSize: 60,
      maxSize: 800,
    },
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    meta: {
      updateData: (rowIndex: number, columnId: string, value: any) => {
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
      },
    },
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

  const tableRows = useMemo(() => table.getRowModel().rows ?? [], [editedData]);

  const renderHeader = useCallback(() => {
    return (
      <tr>
        {table.getHeaderGroups()[0]?.headers.map((header) => (
          <th
            key={header.id}
            class={cn(
              "relative border-r border-neutral-200 bg-neutral-50 px-4 py-2 select-none",
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
    (rowIndex: number, row: Row<any>) => {
      const rowPatched = isRowPatched(rowIndex);

      return row.getVisibleCells().map((cell, colIndex) => {
        const isSelectingRow = editingCell?.rowIdx === rowIndex;
        const isEditing = isSelectingRow && editingCell?.colIdx === colIndex;

        const colName = cell.column.id;
        const cellPatched = isCellPatched(rowIndex, colName);

        return (
          <td
            key={cell.id}
            tabIndex={0}
            style={{ width: cell.column.getSize() }}
            class={cn(
              "max-w-52 min-w-20 border border-neutral-200 text-sm text-neutral-900",
              isSelectingRow ? "bg-blue-200" : "hover:bg-blue-50",
              rowPatched && !isSelectingRow && "bg-amber-50/40",
              cellPatched && !isSelectingRow && "ring-1 ring-amber-200",
              isEditing && "outline-2 -outline-offset-2 outline-blue-500"
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        );
      });
    },
    [editingCell?.rowIdx, editingCell?.colIdx, isCellPatched, isRowPatched]
  );

  return (
    <div class="flex h-full flex-col overflow-hidden bg-white">
      <div class="flex-1 overflow-hidden border-t border-neutral-200">
        <TableVirtuoso
          key={`table-${tableRows.length}-${columns.length}-${offset}-${limit}`}
          style={{ ...columnSizeVars, height: "100%" }}
          data={tableRows}
          components={{
            Table: ({ style, ...props }: any) => {
              return (
                <table
                  {...props}
                  style={{ ...style, width: table.getTotalSize() }}
                />
              );
            },
          }}
          fixedHeaderContent={renderHeader}
          itemContent={renderRow}
        />
      </div>

      <TablePagination
        pagination={pagination}
        limit={limit}
        offset={offset}
        onPageChange={onPageChange}
      />
    </div>
  );
}
