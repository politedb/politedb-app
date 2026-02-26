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
  isEditing: boolean;
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

const INPUT_STYLE = {
  scrollbarWidth: "none",
  msOverflowStyle: "none",
} as const;

// Common class for both View and Edit modes to ensure visual consistency
const CELL_CLASS = cn(
  "h-full w-full border-0 p-2 text-sm text-neutral-900",
  "outline-none hover:cursor-default",
  "overflow-hidden text-ellipsis whitespace-nowrap"
);

// ============================================================================
// Sub-components
// ============================================================================

// 1. View Mode (Super lightweight)
const ViewCell = ({
  value,
  isDeleted,
  onMouseDown,
}: {
  value: string;
  isDeleted: boolean;
  onMouseDown: (e: MouseEvent) => void;
}) => {
  return (
    <div
      className={CELL_CLASS}
      onMouseDown={onMouseDown}
      // Add title for better UX on truncated text
      title={value || "NULL"}
      style={{
        opacity: isDeleted ? 0.5 : 1,
        color: value ? "inherit" : "#9ca3af", // Gray text for NULL
      }}
    >
      {value || "NULL"}
    </div>
  );
};

// 2. Edit Mode (Full functionality)
const EditCell = ({
  initialValue,
  isDeleted,
  onCommit,
  onBlur,
}: {
  initialValue: string;
  isDeleted: boolean;
  onCommit: (val: string) => void;
  onBlur: () => void;
  isNewRow: boolean;
}) => {
  const [editValue, setEditValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus when mounting
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      // Optional: Select all text on focus
      // inputRef.current.select();
    }
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Enter":
        (e.target as HTMLInputElement).blur();
        break;
      case "Escape":
        setEditValue(initialValue); // Revert
        (e.target as HTMLInputElement).blur();
        break;
    }
  };

  const handleBlur = () => {
    onCommit(editValue);
    onBlur();
  };

  const handleInput = (e: Event) => {
    const val = (e.currentTarget as HTMLInputElement).value;
    setEditValue(val);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={editValue}
      disabled={isDeleted}
      className={cn(CELL_CLASS, "bg-white focus:outline-none")}
      style={INPUT_STYLE}
      onInput={handleInput}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const TableCell = memo(function TableCell({
  rowIndex,
  colIndex,
  colName,
  value,
  rowKey,
  isSelecting = false,
  isEditing = false, // Received from parent
  isNewRow = false,
  isDeleted = false,
  onCellChange,
  setEditingCell,
  updateData,
}: TableCellProps) {
  const displayValue = cellToString(value) ?? "";

  // Switch to Edit Mode trigger
  const handleMouseDown = useCallback(
    (_e: MouseEvent) => {
      // Set editing state in parent -> Re-render -> isEditing becomes true -> Render EditCell
      setEditingCell({ rowIdx: rowIndex, colName, colIdx: colIndex });
      if (!isSelecting) {
        // Prevent row selection flicker if needed,
        // but usually we want selection to happen.
        // Keeping logic from original code:
        // e.preventDefault();
      }
    },
    [setEditingCell, rowIndex, colIndex, colName, isSelecting]
  );

  // Commit logic
  const handleCommit = useCallback(
    (newValue: string) => {
      const trimmedEdit = newValue.trim();
      const trimmedDisplay = displayValue.trim();

      if (!isNewRow && trimmedEdit === trimmedDisplay) return;

      updateData(rowIndex, colName, newValue);

      const changeData: Record<string, any> = { [colName]: newValue };
      if (isNewRow && rowKey) {
        changeData.__rowKey = rowKey;
      }

      onCellChange?.(
        isNewRow ? "create" : "update",
        DATA_KEY,
        isNewRow ? -1 : rowIndex,
        changeData
      );
    },
    [
      displayValue,
      isNewRow,
      rowIndex,
      colName,
      rowKey,
      updateData,
      onCellChange,
    ]
  );

  // Conditional Rendering
  if (isEditing && !isDeleted) {
    return (
      <EditCell
        initialValue={displayValue}
        isDeleted={isDeleted}
        isNewRow={isNewRow}
        onCommit={handleCommit}
        onBlur={() => {
          /* Optional: maybe clear editing cell? */
        }}
      />
    );
  }

  return (
    <ViewCell
      value={displayValue}
      isDeleted={isDeleted}
      onMouseDown={handleMouseDown}
    />
  );
});
