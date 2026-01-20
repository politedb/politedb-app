import { useCallback, useEffect, useState, useRef } from "preact/hooks";
import { memo } from "preact/compat";
import { cn } from "src/utils/cn";
import { cellToString } from "src/utils/convert";
import type { DataAction, DataKey } from "src/stores/connection";
import type { EditingCell } from "./tableUtils";

// ============================================================================
// Types
// ============================================================================

export interface TableCellProps {
  rowIndex: number;
  colIndex: number;
  colName: string;
  originalValue: any;
  value: any;
  isPatched: boolean;
  isNewRow?: boolean;
  rowKey?: string;
  isDeleted?: boolean;
  onCellChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  setEditingCell: (cell: EditingCell | null) => void;
  updateData: (rowIndex: number, columnId: string, value: any) => void;
}

// ============================================================================
// Constants
// ============================================================================

const DATA_KEY: DataKey = "data";

// Input style - hide scrollbar
const INPUT_STYLE = {
  scrollbarWidth: "none",
  msOverflowStyle: "none",
} as const;

// Background colors for focus/blur states
const BG_COLORS = {
  focus: "white",
  newRow: "#d1fae5", // bg-green-100
  default: "transparent",
} as const;

// ============================================================================
// Component
// ============================================================================

export const TableCell = memo(function TableCell({
  rowIndex,
  colIndex,
  colName,
  value,
  isPatched,
  isNewRow = false,
  rowKey,
  isDeleted = false,
  onCellChange,
  setEditingCell,
  updateData,
}: TableCellProps) {
  const displayValue = cellToString(value);
  const [editValue, setEditValue] = useState(displayValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync when value changes from outside (patch switch / refresh)
  useEffect(() => {
    setEditValue(displayValue);
  }, [displayValue]);

  // Commit value on blur
  const commitValue = useCallback(() => {
    const trimmedEdit = editValue.trim();
    const trimmedDisplay = displayValue.trim();

    // Skip if unchanged (for existing rows)
    if (!isNewRow && trimmedEdit === trimmedDisplay) return;

    // Update local state
    updateData(rowIndex, colName, editValue);

    // Build change data
    const changeData: Record<string, any> = { [colName]: editValue };
    if (isNewRow && rowKey) {
      changeData.__rowKey = rowKey;
    }

    // Notify parent
    onCellChange?.(
      isNewRow ? "create" : "update",
      DATA_KEY,
      isNewRow ? -1 : rowIndex,
      changeData
    );
  }, [
    editValue,
    displayValue,
    rowIndex,
    colName,
    updateData,
    onCellChange,
    isNewRow,
    rowKey,
  ]);

  // Event handlers - stable references
  const handleInput = useCallback((e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    // Immediate UI update
    (e.currentTarget as HTMLInputElement).value = value;
    // Debounced state update
    requestAnimationFrame(() => setEditValue(value));
  }, []);

  const handleMouseDown = useCallback(() => {
    setEditingCell({ rowIdx: rowIndex, colName, colIdx: colIndex });
  }, [setEditingCell, rowIndex, colIndex, colName]);

  const handleClick = useCallback((e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    input.scrollLeft = input.scrollWidth;
    input.select();
  }, []);

  const handleFocus = useCallback((e: Event) => {
    (e.currentTarget as HTMLInputElement).style.backgroundColor =
      BG_COLORS.focus;
  }, []);

  const handleBlur = useCallback(
    (e: Event) => {
      const input = e.currentTarget as HTMLInputElement;
      input.style.backgroundColor = isNewRow
        ? BG_COLORS.newRow
        : BG_COLORS.default;
      commitValue();
    },
    [commitValue, isNewRow]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "Enter":
          (e.target as HTMLInputElement).blur();
          break;
        case "Escape":
          setEditValue(displayValue);
          break;
      }
    },
    [displayValue]
  );

  // Compute class once
  const inputClass = cn(
    "h-full w-full border-0 p-2 text-sm text-neutral-900",
    "outline-none hover:cursor-default focus:outline-none",
    "overflow-hidden text-ellipsis whitespace-nowrap",
    "focus:overflow-x-auto focus:text-ellipsis",
    isDeleted && "bg-red-300",
    isPatched && !isDeleted && "bg-amber-200",
    isNewRow && !isDeleted && "bg-green-200",
    !isPatched && !isNewRow && !isDeleted && "bg-transparent"
  );

  return (
    <input
      ref={inputRef}
      type="text"
      value={editValue}
      placeholder={editValue ? undefined : "NULL"}
      disabled={isDeleted}
      class={inputClass}
      style={INPUT_STYLE}
      onInput={handleInput}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
});
