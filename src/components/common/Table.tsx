import { useMemo, useRef, useCallback, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { cn } from "src/utils/cn";
import { useFillViewportTable } from "src/hooks/useFillViewportTable";
import { useIndexedSort } from "src/hooks/useIndexedSort";
import { ChevronUpIcon, ChevronDownIcon } from "src/components/icons";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";

export interface TableColumn<T = any> {
  key: string;
  label: string | ComponentChildren;
  className?: string;
  headerClassName?: string;
  render?: (value: any, row: T, index: number) => any;
  sortable?: boolean;
  sortKey?: keyof T;
}

interface TableProps<T = any> {
  columns: TableColumn<T>[];
  data: T[];
  keyExtractor?: (row: T, index: number) => string | number;
  rowIndexExtractor?: (row: T, index: number) => number;
  rowClassName?: string | ((row: T, index: number) => string);
  headerClassName?: string;
  stickyHeader?: boolean;
  className?: string;
  showEmptyMessage?: boolean;
  emptyMessage?: string;
  fillViewport?: boolean;
  estimatedRowHeight?: number;
  selectedRow?: number | null;
  selectedRows?: Set<number>;
  onSelectRow?: (
    row: T,
    index: number,
    multi?: boolean,
    range?: boolean
  ) => void;
  onDoubleClickRow?: (row: T, index: number) => void;
  enableSort?: boolean;
  /** When false, selected rows use the muted unfocused highlight. */
  selectionFocused?: boolean;
}

const TABLE_STYLE = { minHeight: "100%", tableLayout: "auto" } as const;
type HeaderMenuState<T> = { x: number; y: number; column: TableColumn<T> };

export function Table<T = any>({
  columns,
  data,
  keyExtractor,
  rowIndexExtractor,
  rowClassName,
  headerClassName,
  stickyHeader = true,
  className,
  showEmptyMessage = true,
  emptyMessage = "No data available",
  fillViewport = false,
  estimatedRowHeight,
  selectedRow,
  selectedRows,
  onSelectRow,
  onDoubleClickRow,
  enableSort = true,
  selectionFocused = true,
}: TableProps<T>) {
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState<T> | null>(null);
  const [colWidths, setColWidths] = useState<(number | undefined)[]>(() =>
    columns.map(() => undefined)
  );

  const resizingRef = useRef<{
    colIndex: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const { emptyRowsCount, containerRef } = useFillViewportTable({
    tableRef,
    dataLength: data.length,
    estimatedRowHeight,
    fillViewport,
  });

  const {
    sortState,
    sortedRows,
    indexMap,
    toggleSort,
    setSort,
    findDisplayIndex,
  } = useIndexedSort<T, keyof T>(data);

  const displayRows = sortedRows;
  const resolveSortKey = useCallback(
    (col: TableColumn<T>) =>
      (col.sortKey as keyof T | undefined) ?? (col.key as keyof T),
    []
  );

  const isCenterColumn = useCallback(
    (col: TableColumn<T>) =>
      col.key === "_rowNumber" ||
      col.className?.includes("text-center") ||
      col.headerClassName?.includes("text-center"),
    []
  );

  const headerMenuItems = useMemo<MenuItem[]>(() => {
    const col = headerMenu?.column;
    const canSort = !!(enableSort && col?.sortable);
    const sortKey = col ? resolveSortKey(col) : null;
    const copyText = col
      ? typeof col.label === "string"
        ? col.label
        : col.key
      : "";

    return [
      {
        type: "item",
        label: "Copy name",
        disabled: !col,
        onClick: () => {
          if (!copyText) return;
          void navigator.clipboard.writeText(copyText);
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "Sort ascending",
        disabled: !canSort || !sortKey,
        onClick: () => {
          if (!canSort || !sortKey) return;
          setSort(sortKey, "asc");
        },
      },
      {
        type: "item",
        label: "Sort descending",
        disabled: !canSort || !sortKey,
        onClick: () => {
          if (!canSort || !sortKey) return;
          setSort(sortKey, "desc");
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "Remove sort",
        disabled: !enableSort || sortState.key == null,
        onClick: () => {
          if (!enableSort) return;
          setSort(null);
        },
      },
    ];
  }, [headerMenu, enableSort, resolveSortKey, setSort, sortState.key]);

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      const info = resizingRef.current;
      if (!info) return;

      const delta = e.clientX - info.startX;
      const nextWidth = Math.max(50, info.startWidth + delta);

      setColWidths((prev) => {
        const arr =
          prev && prev.length === columns.length
            ? [...prev]
            : columns.map(() => undefined);
        arr[info.colIndex] = nextWidth;
        return arr;
      });
    },
    [columns]
  );

  const handleResizeEnd = useCallback(() => {
    if (!resizingRef.current) return;
    resizingRef.current = null;
    window.removeEventListener("mousemove", handleResizeMove);
    window.removeEventListener("mouseup", handleResizeEnd);
  }, [handleResizeMove]);

  const handleResizeStart = useCallback(
    (e: MouseEvent, colIndex: number) => {
      e.preventDefault();
      e.stopPropagation();

      const target = e.currentTarget as HTMLElement;
      const th = target.closest("th") as HTMLTableCellElement | null;
      const startWidth = th?.offsetWidth ?? 0;

      resizingRef.current = {
        colIndex,
        startX: e.clientX,
        startWidth,
      };

      window.addEventListener("mousemove", handleResizeMove);
      window.addEventListener("mouseup", handleResizeEnd);
    },
    [handleResizeMove, handleResizeEnd]
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
      const row = isEmpty
        ? emptyRow
        : data.find(
            (candidate, index) =>
              (rowIndexExtractor?.(candidate, index) ?? index) === rowIndex
          );

      if (row !== undefined) {
        onSelectRow(row, rowIndex, e.metaKey || e.ctrlKey, e.shiftKey);
      }
    },
    [onSelectRow, data, emptyRow, rowIndexExtractor]
  );

  const handleTableDblClick = useCallback(
    (e: MouseEvent) => {
      if (!onDoubleClickRow) return;

      const tr = (e.target as HTMLElement).closest("tr[data-row]");
      if (!tr) return;

      const rowIndex = Number((tr as HTMLElement).dataset.row);
      if (!Number.isFinite(rowIndex)) return;

      const isEmpty = (tr as HTMLElement).dataset.empty === "true";
      const row = isEmpty
        ? emptyRow
        : data.find(
            (candidate, index) =>
              (rowIndexExtractor?.(candidate, index) ?? index) === rowIndex
          );

      if (row !== undefined) {
        onDoubleClickRow(row, rowIndex);
      }
    },
    [onDoubleClickRow, data, emptyRow, rowIndexExtractor]
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
      <table
        ref={tableRef}
        class={cn(
          "w-full border-collapse border border-t-0 border-neutral-200",
          className
        )}
        style={TABLE_STYLE}
      >
        <colgroup>
          {columns.map((_col, colIndex) => (
            <col
              key={_col.key}
              style={
                colWidths[colIndex]
                  ? { width: `${colWidths[colIndex]}px` }
                  : undefined
              }
            />
          ))}
        </colgroup>

        <thead class={cn("bg-neutral-50", headerClassName)}>
          <tr>
            {columns.map((col, colIndex) => (
              <th
                key={col.key}
                class={cn(
                  "relative border-r border-neutral-50 active:bg-neutral-100",
                  "p-2 text-xs font-semibold text-neutral-700",
                  isCenterColumn(col) ? "text-center" : "text-left",
                  stickyHeader &&
                    "sticky top-0 z-50 bg-neutral-50 shadow-[1px_1px_0_0_rgba(0,0,0,0.15)]",
                  col.headerClassName
                )}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setHeaderMenu({
                    x: e.clientX,
                    y: e.clientY,
                    column: col,
                  });
                }}
              >
                {col.sortable ? (
                  <button
                    class={cn(
                      "flex w-full items-center gap-1 select-none",
                      isCenterColumn(col) ? "justify-center" : "justify-between"
                    )}
                    onMouseUp={(e) => {
                      if (e.button !== 0) return;
                      if (!enableSort) return;
                      const sortKey = resolveSortKey(col);
                      e.stopPropagation();
                      toggleSort(sortKey);
                    }}
                  >
                    <span class="truncate">{col.label}</span>
                    {enableSort &&
                      sortState.key === (col.sortKey ?? (col.key as keyof T)) &&
                      (sortState.direction === "asc" ? (
                        <ChevronUpIcon className="size-3" />
                      ) : (
                        <ChevronDownIcon className="size-3" />
                      ))}
                  </button>
                ) : (
                  col.label
                )}
                <div
                  class="absolute top-0 right-0 z-10 h-full w-0.5 cursor-col-resize hover:bg-neutral-200 active:bg-neutral-400"
                  onMouseDown={(e) => handleResizeStart(e, colIndex)}
                />
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {displayRows.map((row, displayIndex) => {
            const sortedIndex = indexMap[displayIndex] ?? displayIndex;
            const originalIndex =
              rowIndexExtractor?.(row, sortedIndex) ?? sortedIndex;

            let isSelected = false;

            if (selectedRows) {
              isSelected = selectedRows.has(originalIndex);
            } else if (selectedRow != null) {
              isSelected = findDisplayIndex(selectedRow) === displayIndex;
            }

            const isNewRow = (row as any).isNew;
            const dynamicClassName =
              typeof rowClassName === "function"
                ? rowClassName(row, originalIndex)
                : rowClassName;

            return (
              <tr
                key={
                  keyExtractor
                    ? keyExtractor(row, originalIndex)
                    : originalIndex
                }
                data-row={originalIndex}
                class={cn(
                  isNewRow && "bg-new!",
                  isSelected &&
                    (selectionFocused
                      ? "bg-selected!"
                      : "bg-selected-unfocused! text-neutral-500!"),
                  dynamicClassName
                )}
              >
                {columns.map((col, colIndex) => (
                  <td
                    key={col.key}
                    class={cn(
                      "border-r border-b border-neutral-200 px-1",
                      colIndex === 0 && "border-l",
                      col.className
                    )}
                  >
                    {col.render
                      ? col.render((row as any)[col.key], row, originalIndex)
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
                class={cn(
                  typeof rowClassName === "string" ? rowClassName : undefined
                )}
              >
                {columns.map((col, colIndex) => {
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
                        "min-h-10 border-r border-b border-neutral-200 px-1",
                        colIndex === 0 && "border-l",
                        col.className
                      )}
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

      <ContextMenu
        open={headerMenu !== null}
        x={headerMenu?.x ?? 0}
        y={headerMenu?.y ?? 0}
        items={headerMenuItems}
        onClose={() => setHeaderMenu(null)}
      />
    </div>
  );
}
