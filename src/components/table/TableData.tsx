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
  columns: ColumnMeta[];
  data: any[];
  onCellChange?: (rowIndex: number, columnIndex: number, value: any) => void;
}

export function TableData({ columns, data, onCellChange }: Props) {
  // Normalize data on mount and when it changes
  const { tableData } = useNormalizeTableData(columns, data);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(300);
  const [editedData, setEditedData] = useState<any[]>(tableData);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);

  // Update editedData when normalized data changes
  useEffect(() => {
    setEditedData(tableData);
  }, [tableData]);

  // Define table columns
  const tableColumns = useMemo<ColumnDef<any>[]>(
    () =>
      columns.map((col) => ({
        id: col.name,
        accessorFn: (row) => row[col.name]?.v,
        header: col.name,
        cell: ({ cell, row, table }) => {
          const originalValue = tableData[row.index]?.[cell.column.id];
          return (
            <TableCell
              cell={cell}
              row={row}
              table={table}
              originalValue={originalValue}
              onCellChange={onCellChange}
              setEditingCell={setEditingCell}
            />
          );
        },
      })),
    [
      columns,
      editedData,
      tableData,
      onCellChange,
      setEditedData,
      setEditingCell,
    ]
  );

  // Calculate pagination
  const pagination = useMemo(() => {
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;

    return {
      totalRows: tableData.length,
      totalPages: Math.ceil(tableData.length / pageSize),
      startIndex,
      endIndex,
    };
  }, [tableData, pageSize, page]);

  // const paginatedData = useMemo(() => {
  //   return tableData.slice(pagination.startIndex, pagination.endIndex);
  // }, [tableData, pagination.startIndex, pagination.endIndex]);

  // // Transform data for react-table
  // const tableData = useMemo(() => {
  //   if (!paginatedData || paginatedData.length === 0) return [];

  //   return paginatedData.map((row, index) => {
  //     // Ensure row is an array
  //     const rowArray = Array.isArray(row) ? row : [];

  //     return {
  //       ...rowArray.reduce(
  //         (acc, cell, colIndex) => {
  //           acc[columns[colIndex].name] = cell;
  //           return acc;
  //         },
  //         {} as Record<string, any>
  //       ),
  //       __rowIndex: pagination.startIndex + index,
  //     };
  //   });
  // }, [paginatedData, pagination.startIndex]);

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

  // Handle empty data
  if (
    !editedData ||
    editedData.length === 0 ||
    !tableRows ||
    tableRows.length === 0
  ) {
    return (
      <div class="flex h-full items-center justify-center bg-white">
        <p class="text-neutral-500">No data to display</p>
      </div>
    );
  }

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
                className="absolute top-0 right-0 h-full w-[6px] cursor-col-resize"
              />
            )}
          </th>
        ))}
      </tr>
    );
  }, [table]);

  const renderRow = useCallback(
    (rowIndex: number, row: Row<any>) => {
      return row.getVisibleCells().map((cell, colIndex) => {
        const isSelectingRow = editingCell?.rowIdx === rowIndex;
        const isEditing = isSelectingRow && editingCell?.colIdx === colIndex;

        return (
          <td
            key={cell.id}
            tabIndex={0}
            style={{ width: cell.column.getSize() }}
            class={cn(
              "max-w-52 min-w-20 border border-neutral-200 text-sm text-neutral-900",
              isSelectingRow ? "bg-blue-200" : "hover:bg-blue-50",
              isEditing && "outline-2 -outline-offset-2 outline-blue-500"
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        );
      });
    },
    [editingCell?.rowIdx, editingCell?.colIdx]
  );

  return (
    <div class="flex h-full flex-col overflow-hidden bg-white">
      <div class="flex-1 overflow-hidden border-t border-neutral-200">
        <TableVirtuoso
          key={`table-${tableRows.length}-${columns.length}-${page}`}
          style={{
            ...columnSizeVars,
            height: "100%",
            width: table.getTotalSize(),
          }}
          data={tableRows}
          fixedHeaderContent={renderHeader}
          itemContent={renderRow}
        />
      </div>

      <TablePagination
        pagination={pagination}
        page={page}
        pageSize={pageSize}
        setPage={setPage}
        setPageSize={setPageSize}
      />
    </div>
  );
}
