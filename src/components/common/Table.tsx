import { useMemo, useRef } from "preact/hooks";
import { cn } from "src/utils/cn";
import { useFillViewportTable } from "src/hooks/useFillViewportTable";

export interface TableColumn<T = any> {
  key: string;
  label: string;
  className?: string;
  headerClassName?: string;
  render?: (value: any, row: T, index: number) => any;
}

interface TableProps<T = any> {
  columns: TableColumn<T>[];
  data: T[];
  keyExtractor?: (row: T, index: number) => string | number;
  rowClassName?: string | ((row: T, index: number) => string);
  headerClassName?: string;
  stickyHeader?: boolean;
  className?: string;
  emptyMessage?: string;
  fillViewport?: boolean;
  estimatedRowHeight?: number;
  selectedRow?: number | null;
  onSelectRow?: (row: T, index: number) => void;
  onDoubleClickRow?: (row: T, index: number) => void;
}

export function Table<T = any>({
  columns,
  data,
  keyExtractor,
  rowClassName,
  headerClassName,
  stickyHeader = true,
  className,
  emptyMessage = "No data available",
  fillViewport = false,
  estimatedRowHeight = 28,
  selectedRow,
  onSelectRow,
  onDoubleClickRow,
}: TableProps<T>) {
  const tableRef = useRef<HTMLTableElement>(null);

  const getRowKey = (row: T, index: number) => {
    if (keyExtractor) {
      return keyExtractor(row, index);
    }
    return index;
  };

  const { emptyRowsCount, containerRef } = useFillViewportTable({
    tableRef,
    dataLength: data.length,
    estimatedRowHeight,
    fillViewport,
  });

  if (data.length === 0) {
    return (
      <div class="flex h-full items-center justify-center bg-white">
        <p class="text-sm text-neutral-500">{emptyMessage}</p>
      </div>
    );
  }

  // Create empty row data
  const emptyRow = useMemo(
    () =>
      columns.reduce((acc, col) => {
        if (col.key === "_rowNumber") {
          acc[col.key] = null; // Row number will be rendered separately
        } else {
          acc[col.key] = "";
        }
        return acc;
      }, {} as any),
    [columns]
  );

  return (
    <div
      ref={containerRef}
      class={cn(
        "h-full w-full overflow-auto bg-white",
        emptyRowsCount > 0 && "overflow-y-hidden"
      )}
    >
      <table
        ref={tableRef}
        class={cn("w-full", className)}
        style={{ minHeight: "100%", tableLayout: "auto" }}
      >
        <thead
          class={cn(
            "bg-neutral-50",
            stickyHeader && "sticky top-0 z-10",
            headerClassName
          )}
        >
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                class={cn(
                  "border border-neutral-300 p-2 text-left text-xs font-semibold text-neutral-700",
                  column.headerClassName
                )}
                style={{ width: `${100 / columns.length}%` }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => {
            const dynamicRowClassName =
              typeof rowClassName === "function"
                ? rowClassName(row, index)
                : rowClassName;

            return (
              <tr
                key={getRowKey(row, index)}
                class={cn(
                  (row as any).isNew && "bg-green-200!",
                  selectedRow === index && "bg-blue-200!",
                  dynamicRowClassName
                )}
                onClick={() => onSelectRow?.(row, index)}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    class={cn(
                      "border border-neutral-200 px-1",
                      column.className
                    )}
                  >
                    {column.render
                      ? column.render((row as any)[column.key], row, index)
                      : (row as any)[column.key]}
                  </td>
                ))}
              </tr>
            );
          })}
          {/* Fill empty rows to cover viewport */}
          {Array.from({ length: emptyRowsCount }).map((_, idx) => {
            const rowIndex = data.length + idx;
            return (
              <tr
                key={`empty-${idx}`}
                class={cn(
                  rowClassName,
                  selectedRow === rowIndex && "bg-blue-200!"
                )}
                onClick={() => onSelectRow?.(emptyRow, rowIndex)}
                onDblClick={() => onDoubleClickRow?.(emptyRow, rowIndex)}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    class={cn(
                      "min-h-[40px] border border-neutral-200 px-1",
                      column.className
                    )}
                  >
                    {column.key === "_rowNumber"
                      ? column.render
                        ? column.render(rowIndex + 1, emptyRow, rowIndex)
                        : rowIndex + 1
                      : column.render
                        ? column.render(
                            emptyRow[column.key],
                            emptyRow,
                            rowIndex
                          )
                        : ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
