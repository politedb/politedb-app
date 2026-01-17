import { Cell, Row, Table } from "@tanstack/react-table";
import { cellToString } from "src/utils/convert";
import {
  Dispatch,
  useCallback,
  useEffect,
  useState,
  useRef,
} from "preact/hooks";
import { cn } from "src/utils/cn";
import { memo, SetStateAction } from "preact/compat";
import { EditingCell } from "./TableData";
import { DataAction, DataKey } from "src/stores/connection";

interface Props {
  cell: Cell<any, any>;
  row: Row<any>;
  table: Table<any>;
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
  setEditingCell: Dispatch<SetStateAction<EditingCell | null>>;
}

export const TableCell = memo(function TableCell({
  cell,
  row,
  table,
  colName,
  // originalValue,
  value,
  isPatched,
  isNewRow = false,
  rowKey,
  isDeleted = false,
  onCellChange,
  setEditingCell,
}: Props) {
  const dataKey = "data";
  const rowIndex = row.index;
  const colIndex = cell.column.getIndex();

  const displayValue = cellToString(value);
  // TODO use original value if needed
  // const originalString = cellToString(originalValue);

  const [editValue, setEditValue] = useState(displayValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync when value changes from outside (patch switch / refresh)
  useEffect(() => {
    setEditValue(displayValue);
  }, [displayValue]);

  const commitValue = useCallback(() => {
    // Only commit if the value actually changed
    // Normalize both values for comparison (trim whitespace, treat empty string as empty)
    const normalizedEditValue = editValue.trim();
    const normalizedDisplayValue = displayValue.trim();

    // For new rows, always commit (even if empty, it's still a new row)
    // For existing rows, only commit if the value changed
    if (!isNewRow && normalizedEditValue === normalizedDisplayValue) {
      // Value hasn't changed, don't create a patch
      return;
    }

    // Update local editedData (tanstack meta)
    (table.options.meta as any)?.updateData(rowIndex, colName, editValue);

    // For new rows, use "create" action and include the rowKey
    // For existing rows, use "update" action
    const action = isNewRow ? "create" : "update";
    const changeData: Record<string, any> = { [colName]: editValue };

    // Include rowKey for new rows so handleDataChange can extract it
    if (isNewRow && rowKey) {
      changeData.__rowKey = rowKey;
    }

    // Bubble up to ConnectionScreen → patchMap
    onCellChange?.(action, dataKey, isNewRow ? -1 : rowIndex, changeData);
  }, [
    editValue,
    displayValue,
    rowIndex,
    colName,
    table.options.meta,
    onCellChange,
    isNewRow,
    rowKey,
  ]);

  const onInputBlur = useCallback(
    (e: Event) => {
      // Check if we're still editing this cell (not switched to another)
      const input = e.currentTarget as HTMLInputElement;
      input.style.backgroundColor = "transparent";
      commitValue();
    },
    [commitValue]
  );

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      } else if (e.key === "Escape") {
        // revert to last committed value (patch-aware)
        setEditValue(displayValue);
      }
    },
    [displayValue]
  );

  const onMouseDown = useCallback(() => {
    setEditingCell({
      rowIdx: rowIndex,
      colName,
      colIdx: colIndex,
    });
  }, [setEditingCell, rowIndex, colIndex, colName]);

  const handleInput = useCallback((e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    setEditValue(input.value);
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={editValue}
      placeholder={!editValue ? "NULL" : undefined}
      onInput={handleInput}
      onMouseDown={onMouseDown}
      onClick={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        input.scrollLeft = input.scrollWidth;
        input.select();
      }}
      onFocus={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        input.style.backgroundColor = "white";
      }}
      onBlur={onInputBlur}
      onKeyDown={onInputKeyDown}
      class={cn(
        "h-full w-full border-0 p-2 text-sm text-neutral-900",
        "outline-none hover:cursor-default focus:outline-none",
        "overflow-hidden text-ellipsis whitespace-nowrap",
        "focus:overflow-x-auto focus:text-ellipsis",

        // deleted row (grayed out with strikethrough)
        isDeleted && "bg-red-300",

        // patched highlight (amber) - only if not deleted
        isPatched && !isDeleted && "bg-amber-200",

        // new row highlight (green) - only if not deleted
        isNewRow && !isDeleted && "bg-green-200",

        // untouched
        !isPatched && !isDeleted && "bg-transparent"
      )}
      disabled={isDeleted}
      style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
    />
  );
});
