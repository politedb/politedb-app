import { useMemo, useState, useEffect } from "preact/hooks";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import { TableVirtuoso } from "react-virtuoso";
import { cellToString } from "../utils/convert";
import type { ColumnMeta } from "../lib/tauri/types";
import { cn } from "../utils/cn";

type EditableTableProps = {
  columns: ColumnMeta[];
  data: any[];
  onCellChange?: (rowIndex: number, columnIndex: number, value: any) => void;
};

// Normalize data: convert objects with numeric keys to arrays
function normalizeData(data: any[]): any[][] {
  if (!data || data.length === 0) return [];

  return data.map((row) => {
    // If row is already an array, return it
    if (Array.isArray(row)) {
      return row;
    }

    // If row is an object with numeric keys, convert to array
    if (typeof row === "object" && row !== null) {
      // Get all numeric keys and sort them
      const keys = Object.keys(row)
        .map(Number)
        .filter((k) => !isNaN(k))
        .sort((a, b) => a - b);

      // Return array of values in order
      return keys.map((key) => row[key]);
    }

    // Fallback: return empty array
    return [];
  });
}

export function EditableTable({
  columns,
  data,
  onCellChange,
}: EditableTableProps) {
  // Normalize data on mount and when it changes
  const normalizedData = useMemo(() => normalizeData(data), [data]);

  const [editingCell, setEditingCell] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [editedData, setEditedData] = useState<any[][]>(normalizedData);
  const [editValue, setEditValue] = useState<string>("");

  // Update editedData when normalized data changes
  useEffect(() => {
    setEditedData(normalizedData);
  }, [normalizedData]);

  // Update editValue when editing cell changes
  useEffect(() => {
    if (editingCell) {
      const cellValue = editedData[editingCell.row]?.[editingCell.col];
      setEditValue(cellToString(cellValue) || "");
    }
  }, [editingCell, editedData]);

  // Define table columns
  const tableColumns = useMemo<ColumnDef<any>[]>(
    () =>
      columns.map((col, colIndex) => ({
        id: col.name,
        accessorKey: colIndex.toString(),
        header: col.name,
        cell: ({ row }) => {
          const rowIndex = row.index;
          const cellValue = editedData[rowIndex]?.[colIndex];
          const isEditing =
            editingCell?.row === rowIndex && editingCell?.col === colIndex;

          if (isEditing) {
            return (
              <input
                type="text"
                value={editValue}
                onInput={(e: any) => {
                  setEditValue(e.currentTarget.value);
                }}
                onBlur={() => {
                  const newData = [...editedData];
                  if (!newData[rowIndex]) {
                    newData[rowIndex] = [...(normalizedData[rowIndex] || [])];
                  }
                  newData[rowIndex][colIndex] = editValue;
                  setEditedData(newData);

                  if (onCellChange) {
                    onCellChange(rowIndex, colIndex, editValue);
                  }
                  setEditingCell(null);
                }}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    const newData = [...editedData];
                    if (!newData[rowIndex]) {
                      newData[rowIndex] = [...(normalizedData[rowIndex] || [])];
                    }
                    newData[rowIndex][colIndex] = editValue;
                    setEditedData(newData);

                    if (onCellChange) {
                      onCellChange(rowIndex, colIndex, editValue);
                    }
                    setEditingCell(null);
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === "Escape") {
                    // Revert changes
                    setEditValue(cellToString(cellValue) || "");
                    setEditingCell(null);
                  }
                }}
                class="w-full rounded border border-blue-500 bg-white px-2 py-1 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                autoFocus
              />
            );
          }

          return (
            <div
              class="flex min-h-8 cursor-pointer items-center px-4 py-2 text-sm whitespace-nowrap text-neutral-900 hover:bg-blue-50"
              onClick={() => setEditingCell({ row: rowIndex, col: colIndex })}
              title="Click to edit"
            >
              {cellToString(cellValue) || (
                <span class="text-neutral-400 italic">NULL</span>
              )}
            </div>
          );
        },
      })),
    [columns, editedData, editingCell, normalizedData, onCellChange, editValue]
  );

  // Transform data for react-table
  const tableData = useMemo(() => {
    if (!editedData || editedData.length === 0) return [];

    return editedData.map((row, index) => {
      // Ensure row is an array
      const rowArray = Array.isArray(row) ? row : [];

      return {
        ...rowArray.reduce(
          (acc, cell, colIndex) => {
            acc[colIndex.toString()] = cell;
            return acc;
          },
          {} as Record<string, any>
        ),
        __rowIndex: index,
      };
    });
  }, [editedData]);

  const table = useReactTable({
    data: tableData,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const { rows } = table.getRowModel();

  // Handle empty data
  if (
    !normalizedData ||
    normalizedData.length === 0 ||
    !rows ||
    rows.length === 0
  ) {
    return (
      <div class="flex h-full items-center justify-center bg-white">
        <p class="text-neutral-500">No data to display</p>
      </div>
    );
  }

  // Ensure rows is an array
  const rowsArray = Array.isArray(rows) ? rows : [];

  return (
    <div class="h-full overflow-hidden bg-white">
      <TableVirtuoso
        key={`table-${rowsArray.length}-${columns.length}`}
        style={{ height: "100%" }}
        data={tableData}
        // components={{
        //   Table: React.forwardRef((props: any, ref) => {
        //     const { style, ...restProps } = props;
        //     return (
        //       <table
        //         {...restProps}
        //         ref={ref}
        //         className="w-full border-collapse"
        //         style={{ ...style, tableLayout: "auto" }}
        //       />
        //     );
        //   }),
        //   TableHead: (props: any) => {
        //     const { style, ...restProps } = props;
        //     return <thead {...restProps} class="bg-neutral-50 sticky top-0 z-10" style={style} />;
        //   },
        //   TableBody: (props: any) => {
        //     const { style, ...restProps } = props;
        //     return <tbody {...restProps} style={style} />;
        //   },
        //   TableRow: (props: any) => {
        //     const { item, ...restProps } = props;
        //     try {
        //       if (!item || typeof item !== "object" || !("original" in item)) {
        //         return <tr {...restProps} />;
        //       }
        //       const row = item.original;
        //       if (!row || typeof row !== "object") {
        //         return <tr {...restProps} />;
        //       }
        //       const rowIndex = row?.__rowIndex ?? 0;
        //       return (
        //         <tr
        //           {...restProps}
        //           class={`border-b border-neutral-100 ${
        //             rowIndex % 2 === 0 ? "bg-white" : "bg-neutral-50"
        //           } hover:bg-blue-50`}
        //         />
        //       );
        //     } catch (error) {
        //       console.error("Error in TableRow:", error);
        //       return <tr {...restProps} />;
        //     }
        //   },
        // }}
        fixedHeaderContent={() => (
          <tr>
            {table.getHeaderGroups()[0]?.headers.map((header) => (
              <th
                key={header.id}
                class="border-b border-neutral-200 bg-white px-4 py-2 text-left text-xs font-semibold whitespace-nowrap text-neutral-700 shadow-sm"
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
              </th>
            ))}
          </tr>
        )}
        itemContent={(_index, row) => {
          return Object.values(row).map((cell: any, index: number) => (
            <td
              key={index}
              class={cn(
                "overflow-hidden border-b border-neutral-100 px-4 py-2 text-sm text-neutral-900",
                index > 0 && "border-l border-neutral-100"
              )}
              style={{ maxWidth: "200px" }}
            >
              <p
                class="truncate overflow-hidden text-ellipsis whitespace-nowrap"
                title={String(cell.v || "")}
              >
                {typeof cell === "object" && "v" in cell
                  ? cellToString(cell)
                  : ""}
              </p>
            </td>
          ));
        }}
      />
    </div>
  );
}
