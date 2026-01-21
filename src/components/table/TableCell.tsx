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
  rowKey?: string;
  isSelecting?: boolean;
  isNewRow?: boolean;
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

// ============================================================================
// Component
// ============================================================================

export const TableCell = memo(function TableCell({
  rowIndex,
  colIndex,
  colName,
  value,
  rowKey,
  isSelecting = false,
  isNewRow = false,
  isDeleted = false,
  onCellChange,
  setEditingCell,
  updateData,
}: TableCellProps) {
  const displayValue = cellToString(value);
  const [editValue, setEditValue] = useState(displayValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const ignoreBlurRef = useRef<boolean>(false);

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
    isNewRow,
    rowKey,
    updateData,
    onCellChange,
  ]);

  // Event handlers - stable references
  const handleInput = useCallback((e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    // Immediate UI update
    (e.currentTarget as HTMLInputElement).value = value;
    // Debounced state update
    requestAnimationFrame(() => setEditValue(value));
  }, []);

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      setEditingCell({ rowIdx: rowIndex, colName, colIdx: colIndex });
      if (!isSelecting) {
        e.preventDefault();
      }
    },
    [setEditingCell, rowIndex, colIndex, colName, isSelecting]
  );

  const handleClick = useCallback(
    (e: Event) => {
      if (isSelecting) {
        const input = e.currentTarget as HTMLInputElement;
        input.scrollLeft = input.scrollWidth;
        input.select();
      }
    },
    [isSelecting]
  );

  const handleBlur = useCallback(() => {
    if (ignoreBlurRef.current) {
      ignoreBlurRef.current = false;
      return;
    }

    commitValue();
  }, [commitValue, isNewRow]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "Enter":
          (e.target as HTMLInputElement).blur();
          break;
        case "Escape":
          setEditValue(displayValue);
          ignoreBlurRef.current = true;
          (e.target as HTMLInputElement).blur();
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
    "focus:overflow-x-auto focus:text-ellipsis focus:bg-white!"
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
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
});
