import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "preact/hooks";
import { TableVirtuoso } from "react-virtuoso";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cn } from "src/utils/cn";
import { useNormalizeTableData } from "src/hooks/useNormalizeTableData";
import { useFillViewportTable } from "src/hooks/useFillViewportTable";
import { useTablePatches } from "src/screens/connection/hooks/useTablePatches";
import { useTableRowSelection } from "src/screens/connection/hooks/useTableRowSelection";
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
  onDeleteRow?: (rowIndex: number) => void;

  // rowIndexStr -> colName -> value
  patches?: Record<string, Record<string, any>> | null;

  // Array of row keys that represent new rows (for create action)
  newRowKeys?: string[];

  // Set of row indices that are marked for deletion
  deletedRows?: Set<number>;
}

const EMPTY_ARRAY: string[] = [];
const EMPTY_SET = new Set<number>();

export function TableData({
  columns,
  data,
  patches,
  onCellChange,
  onDeleteRow,
  newRowKeys = EMPTY_ARRAY,
  deletedRows = EMPTY_SET,
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

  // Use patches hook for patch-related logic
  const {
    getRowKey,
    isNewRow,
    isRowDeleted,
    getPatchedValue,
    isCellPatched,
    isRowPatched,
  } = useTablePatches({
    patches,
    newRowKeys,
    deletedRows,
    editedDataLength: editedData.length,
  });

  // Use row selection hook for keyboard events and selection
  const { handleRowSelect, keyboardContainerRef } = useTableRowSelection({
    onDeleteRow,
    deletedRows,
    isNewRow,
  });

  // Column resizing state
  const [columnSizes, setColumnSizes] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    columns.forEach((col) => {
      initial[col.name] = 80; // default size
    });
    return initial;
  });

  const [isResizing, setIsResizing] = useState<string | null>(null);
  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(0);
  const resizeColumn = useRef<string | null>(null);

  // Container width tracking for empty column
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Column resize handlers
  const handleResizeStart = useCallback(
    (colName: string, e: MouseEvent | TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(colName);
      resizeColumn.current = colName;
      const clientX =
        "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX;
      resizeStartX.current = clientX;
      resizeStartWidth.current = columnSizes[colName] || 80;
    },
    [columnSizes]
  );

  const handleResizeMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!resizeColumn.current) return;

    const clientX =
      "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX;
    const diff = clientX - resizeStartX.current;
    const newWidth = Math.max(
      60,
      Math.min(800, resizeStartWidth.current + diff)
    );

    setColumnSizes((prev) => ({
      ...prev,
      [resizeColumn.current!]: newWidth,
    }));
  }, []);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(null);
    resizeColumn.current = null;
  }, []);

  // Attach resize listeners
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => handleResizeMove(e);
    const handleMouseUp = () => handleResizeEnd();
    const handleTouchMove = (e: TouchEvent) => handleResizeMove(e);
    const handleTouchEnd = () => handleResizeEnd();

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("touchmove", handleTouchMove);
    document.addEventListener("touchend", handleTouchEnd);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  // Update data handler
  const updateData = useCallback(
    (rowIndex: number, columnId: string, value: any) => {
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
    [editedData.length]
  );

  // Calculate empty rows to fill viewport
  const { emptyRowsCount, containerRef: viewportContainerRef } =
    useFillViewportTable({
      dataLength: allData.length,
      fillViewport: true,
      headerHeight: 40,
    });

  // Calculate total table width for horizontal scrolling
  const totalTableWidth = useMemo(() => {
    const columnsWidth = columns.reduce((sum, col) => {
      return sum + (columnSizes[col.name] || 80);
    }, 0);

    // Calculate remaining width for empty column
    const remainingWidth = Math.max(0, containerWidth - columnsWidth);

    return columnsWidth + remainingWidth;
  }, [columns, columnSizes, containerWidth]);

  // Calculate empty column width
  const emptyColumnWidth = useMemo(() => {
    const columnsWidth = columns.reduce((sum, col) => {
      return sum + (columnSizes[col.name] || 80);
    }, 0);
    return Math.max(0, containerWidth - columnsWidth);
  }, [columns, columnSizes, containerWidth]);

  // Track container width using ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Merge keyboard container ref with viewport container ref
  const mergedContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (keyboardContainerRef?.current !== undefined) {
        keyboardContainerRef.current = node;
      }
      if (
        viewportContainerRef &&
        typeof viewportContainerRef === "object" &&
        viewportContainerRef !== null &&
        "current" in viewportContainerRef
      ) {
        (viewportContainerRef as { current: HTMLDivElement | null }).current =
          node;
      }
    },
    [viewportContainerRef, keyboardContainerRef]
  );

  // Create row data for virtualization
  const tableRows = useMemo(() => {
    return allData.map((row, index) => ({
      id: `row-${index}`,
      index,
      data: row,
    }));
  }, [allData]);

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
        {columns.map((col) => {
          const colName = col.name;
          const width = columnSizes[colName] || 80;
          return (
            <th
              key={colName}
              class={cn(
                "relative border-r border-neutral-200 bg-neutral-50 p-2 select-none",
                "text-left text-xs font-semibold whitespace-nowrap text-neutral-700 shadow-sm"
              )}
              style={{ width: `${width}px` }}
            >
              {colName}
              <div
                onMouseDown={(e) => handleResizeStart(colName, e)}
                onTouchStart={(e) => handleResizeStart(colName, e)}
                onDblClick={() =>
                  setColumnSizes((prev) => ({ ...prev, [colName]: 80 }))
                }
                className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize"
              />
            </th>
          );
        })}
        {emptyColumnWidth > 0 && (
          <th
            key="empty"
            class={cn(
              "border-r border-neutral-200 bg-neutral-50 p-2 select-none",
              "text-left text-xs font-semibold whitespace-nowrap text-neutral-700 shadow-sm"
            )}
            style={{ width: `${emptyColumnWidth}px` }}
          >
            {/* Empty column header */}
          </th>
        )}
      </tr>
    );
  }, [columns, columnSizes, handleResizeStart, emptyColumnWidth]);

  const renderRow = useCallback(
    (rowIndex: number, rowData: any) => {
      const isEmptyRow = rowData?.id?.startsWith("empty-");
      const actualRowIndex = isEmptyRow ? rowData.index : rowIndex;
      const rowPatched = !isEmptyRow && isRowPatched(actualRowIndex, newRows);

      if (isEmptyRow) {
        // Render empty row
        return (
          <>
            {columns.map((col) => {
              const colName = col.name;
              const width = columnSizes[colName] || 80;
              return (
                <td
                  key={colName}
                  class={cn("h-[28px] border border-neutral-200 px-1")}
                  style={{ width: `${width}px` }}
                />
              );
            })}
            {emptyColumnWidth > 0 && (
              <td
                key="empty"
                class={cn("h-[28px] border border-neutral-200 px-1")}
                style={{ width: `${emptyColumnWidth}px` }}
              />
            )}
          </>
        );
      }

      const rowIsNew = isNewRow(actualRowIndex);
      const isSelectingRow = editingCell?.rowIdx === actualRowIndex;
      const rowDeleted = isRowDeleted(actualRowIndex);

      return (
        <>
          {columns.map((col, colIndex) => {
            const isEditing =
              isSelectingRow && editingCell?.colIdx === colIndex;
            const colName = col.name;
            const cellPatched = isCellPatched(actualRowIndex, colName, newRows);
            const width = columnSizes[colName] || 80;

            const originalValue =
              actualRowIndex < tableData.length
                ? tableData[actualRowIndex]?.[colName]
                : null;

            // prefer patch -> editedData -> original(tableData)
            const fallback =
              actualRowIndex < allData.length
                ? allData[actualRowIndex]?.[colName]?.v
                : null;
            const value = getPatchedValue(
              actualRowIndex,
              colName,
              fallback,
              newRows
            );
            const rowKey = getRowKey(actualRowIndex, newRows);

            return (
              <td
                key={`${actualRowIndex}-${colName}`}
                tabIndex={0}
                style={{ width: `${width}px` }}
                class={cn(
                  "max-w-52 min-w-20 border border-neutral-200 text-sm text-neutral-900",
                  isSelectingRow ? "bg-blue-200!" : "hover:bg-blue-50",
                  rowIsNew && !isSelectingRow && "bg-green-50/40",
                  rowDeleted && !isSelectingRow && "bg-red-50/20 opacity-50",
                  rowPatched &&
                    !isSelectingRow &&
                    !rowIsNew &&
                    !rowDeleted &&
                    "bg-amber-50/40",
                  cellPatched && !isSelectingRow && "ring-1 ring-amber-200",
                  isEditing && "outline-2 -outline-offset-2 outline-blue-500"
                )}
                onMouseDown={(e) => {
                  // Set selected row when clicking on a cell
                  e.stopPropagation();
                  handleRowSelect(actualRowIndex);
                }}
              >
                <TableCell
                  rowIndex={actualRowIndex}
                  colIndex={colIndex}
                  colName={colName}
                  originalValue={originalValue}
                  value={value}
                  isPatched={cellPatched}
                  isNewRow={rowIsNew}
                  rowKey={rowKey}
                  isDeleted={rowDeleted}
                  onCellChange={onCellChange}
                  setEditingCell={setEditingCell}
                  updateData={updateData}
                />
              </td>
            );
          })}
          {emptyColumnWidth > 0 && (
            <td
              key={`${actualRowIndex}-empty`}
              class={cn(
                "border border-neutral-200 text-sm text-neutral-900",
                isSelectingRow ? "bg-blue-200!" : "hover:bg-blue-50",
                rowIsNew && "bg-green-200!",
                rowIsNew && !isSelectingRow && "bg-green-50/40"
              )}
              style={{ width: `${emptyColumnWidth}px` }}
              onMouseDown={(e) => {
                e.stopPropagation();
                handleRowSelect(actualRowIndex);
              }}
            />
          )}
        </>
      );
    },
    [
      columns,
      columnSizes,
      editingCell?.rowIdx,
      editingCell?.colIdx,
      isCellPatched,
      isRowPatched,
      isNewRow,
      isRowDeleted,
      tableData,
      allData,
      getPatchedValue,
      getRowKey,
      newRows,
      handleRowSelect,
      onCellChange,
      setEditingCell,
      updateData,
      emptyColumnWidth,
    ]
  );

  return (
    <div
      ref={mergedContainerRef}
      class="flex h-full flex-col overflow-hidden bg-white"
      tabIndex={0}
    >
      <div class="flex-1 overflow-x-auto overflow-y-hidden border-t border-neutral-200">
        <TableVirtuoso
          key={`table-${allRows.length}-${columns.length}`}
          style={{
            height: "100%",
            width: `${Math.max(totalTableWidth, containerWidth || 100)}px`,
            minWidth: "100%",
            overflowY: emptyRowsCount > 0 ? "hidden" : "auto",
          }}
          data={allRows}
          fixedHeaderContent={renderHeader}
          itemContent={renderRow}
          overscan={100}
          increaseViewportBy={{ top: 200, bottom: 200 }}
          minOverscanItemCount={{ top: 100, bottom: 100 }}
        />
      </div>
    </div>
  );
}
