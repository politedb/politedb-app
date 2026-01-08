import { Cell, Row, Table } from "@tanstack/react-table";
import { cellToString } from "../../utils/convert";
import {
  Dispatch,
  useCallback,
  useEffect,
  useState,
  useRef,
} from "preact/hooks";
import { cn } from "../../utils/cn";
import { memo, SetStateAction } from "preact/compat";
import { EditingCell } from "./TableData";

interface Props {
  cell: Cell<any, any>;
  row: Row<any>;
  table: Table<any>;
  onCellChange?: (rowIndex: number, colIdx: number, value: any) => void;
  setEditingCell: Dispatch<SetStateAction<EditingCell | null>>;
}

export const TableCell = memo(function TableCell({
  cell,
  row,
  table,
  onCellChange,
  setEditingCell,
}: Props) {
  const rowIndex = row.index;
  const colIndex = cell.column.getIndex();
  const cellValue = cellToString(cell.getValue());

  const [editValue, setEditValue] = useState(cellValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditValue(cellValue);
  }, [cellValue]);

  const commitValue = useCallback(() => {
    (table.options.meta as any)?.updateData(
      rowIndex,
      cell.column.id,
      editValue
    );
    onCellChange?.(rowIndex, colIndex, editValue);
  }, [
    editValue,
    rowIndex,
    colIndex,
    cell.column.id,
    table.options.meta,
    onCellChange,
    setEditingCell,
  ]);

  const onInputBlur = useCallback(() => {
    // Check if we're still editing this cell (not switched to another)
    commitValue();
  }, [commitValue]);

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      } else if (e.key === "Escape") {
        // Revert changes
        setEditValue(cellToString(cellValue));
        // (e.target as HTMLInputElement).blur();
      }
    },
    [cellValue, setEditValue, setEditingCell]
  );

  const onMouseDown = useCallback(() => {
    setEditingCell({
      rowIdx: rowIndex,
      colName: cell.column.id,
      colIdx: colIndex,
    });
  }, [setEditingCell, rowIndex, colIndex, cell.column.id]);

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
        "h-full w-full border-0 bg-transparent p-2 text-sm text-neutral-900",
        "outline-none hover:cursor-default focus:outline-none",
        "overflow-x-auto"
      )}
      style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
    />
  );
});
