import { useMemo, useRef, useCallback } from "preact/hooks";
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
  showEmptyMessage?: boolean;
  emptyMessage?: string;
  fillViewport?: boolean;
  estimatedRowHeight?: number;
  selectedRow?: number | null;
  onSelectRow?: (row: T, index: number) => void;
  onDoubleClickRow?: (row: T, index: number) => void;
}

const TABLE_STYLE = { minHeight: "100%", tableLayout: "auto" } as const;

export function Table<T = any>({
  columns,
  data,
  keyExtractor,
  rowClassName,
  headerClassName,
  stickyHeader = true,
  className,
  showEmptyMessage = true,
  emptyMessage = "No data available",
  fillViewport = false,
  estimatedRowHeight,
  selectedRow,
  onSelectRow,
  onDoubleClickRow,
}: TableProps<T>) {
  const tableRef = useRef<HTMLTableElement>(null);

  const { emptyRowsCount, containerRef } = useFillViewportTable({
    tableRef,
    dataLength: data.length,
    estimatedRowHeight,
    fillViewport,
  });

  // Column width style (cached)
  const columnWidthStyle = useMemo(
    () => ({ width: `${100 / columns.length}%` }),
    [columns.length]
  );

  // Empty row template
  const emptyRow = useMemo(() => {
    const row: Record<string, any> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      row[col.key] = col.key === "_rowNumber" ? null : "";
    }
    return row as T;
  }, [columns]);

  // Event delegation for row clicks
  const handleTableClick = useCallback(
    (e: MouseEvent) => {
      if (!onSelectRow) return;

      const tr = (e.target as HTMLElement).closest("tr[data-row]");
      if (!tr) return;

      const rowIndex = Number((tr as HTMLElement).dataset.row);
      if (!Number.isFinite(rowIndex)) return;

      const isEmpty = (tr as HTMLElement).dataset.empty === "true";
      const row = isEmpty ? emptyRow : data[rowIndex];

      if (row !== undefined) {
        onSelectRow(row, rowIndex);
      }
    },
    [onSelectRow, data, emptyRow]
  );

  const handleTableDblClick = useCallback(
    (e: MouseEvent) => {
      if (!onDoubleClickRow) return;

      const tr = (e.target as HTMLElement).closest("tr[data-row]");
      if (!tr) return;

      const rowIndex = Number((tr as HTMLElement).dataset.row);
      if (!Number.isFinite(rowIndex)) return;

      const isEmpty = (tr as HTMLElement).dataset.empty === "true";
      const row = isEmpty ? emptyRow : data[rowIndex];

      if (row !== undefined) {
        onDoubleClickRow(row, rowIndex);
      }
    },
    [onDoubleClickRow, data, emptyRow]
  );

  // Early return for empty data
  if (data.length === 0 && showEmptyMessage) {
    return (
      <div class="flex h-full items-center justify-center bg-white">
        <p class="text-sm text-neutral-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      class={cn(
        "h-full overflow-auto bg-white",
        emptyRowsCount > 0 && "overflow-y-hidden"
      )}
      onClick={handleTableClick}
      onDblClick={handleTableDblClick}
    >
      <table ref={tableRef} class={cn(className)} style={TABLE_STYLE}>
        <thead class={cn("bg-neutral-50", headerClassName)}>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                class={cn(
                  "border-r border-neutral-300",
                  "p-2 text-left text-xs font-semibold text-neutral-700",
                  stickyHeader && "sticky top-0 z-50 bg-neutral-50 shadow-sm",
                  col.headerClassName
                )}
                style={columnWidthStyle}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {data.map((row, index) => {
            const isSelected = selectedRow === index;
            const isNewRow = (row as any).isNew;
            const dynamicClassName =
              typeof rowClassName === "function"
                ? rowClassName(row, index)
                : rowClassName;

            return (
              <tr
                key={keyExtractor ? keyExtractor(row, index) : index}
                data-row={index}
                class={cn(
                  isNewRow && "bg-green-200!",
                  isSelected && "bg-blue-200!",
                  dynamicClassName
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    class={cn("border border-neutral-200 px-1", col.className)}
                    style={columnWidthStyle}
                  >
                    {col.render
                      ? col.render((row as any)[col.key], row, index)
                      : (row as any)[col.key]}
                  </td>
                ))}
              </tr>
            );
          })}

          {/* Empty rows to fill viewport */}
          {Array.from({ length: emptyRowsCount }, (_, idx) => {
            const rowIndex = data.length + idx;

            return (
              <tr
                key={`empty-${idx}`}
                data-row={rowIndex}
                data-empty="true"
                class={
                  typeof rowClassName === "string" ? rowClassName : undefined
                }
              >
                {columns.map((col) => {
                  let content: any = "";
                  if (col.key === "_rowNumber") {
                    content = col.render
                      ? col.render(rowIndex + 1, emptyRow, rowIndex)
                      : rowIndex + 1;
                  } else if (col.render) {
                    content = col.render(
                      (emptyRow as any)[col.key],
                      emptyRow,
                      rowIndex
                    );
                  }

                  return (
                    <td
                      key={col.key}
                      class={cn(
                        "min-h-10 border border-neutral-200 px-1",
                        col.className
                      )}
                      style={columnWidthStyle}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
