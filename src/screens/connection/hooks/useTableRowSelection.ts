import { useState, useEffect, useRef, useCallback } from "preact/hooks";

export interface UseTableRowSelectionProps {
  onDeleteRow?: (rowIndex: number) => void;
  deletedRows?: Set<number>;
  isNewRow?: (rowIndex: number) => boolean;
  containerRef?: { current: HTMLDivElement | null };
  /** Number of selectable data rows (excludes viewport filler rows). */
  totalRows?: number;
  /** When set, Cmd/Ctrl+A selects these indices instead of 0..totalRows-1. */
  selectableRowIndices?: number[];
  /** Whether the table area is currently focused (see useTableFocusState). */
  isTableFocused?: boolean;
}

export function useTableRowSelection({
  onDeleteRow,
  deletedRows = new Set(),
  isNewRow,
  containerRef,
  totalRows = 0,
  selectableRowIndices,
  isTableFocused = true,
}: UseTableRowSelectionProps) {
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [lastSelectedRow, setLastSelectedRow] = useState<number | null>(null);

  const [selectedColIndex, setSelectedColIndex] = useState<number | null>(null);
  const keyboardContainerRef = useRef<HTMLDivElement>(null);
  const isTableFocusedRef = useRef(isTableFocused);
  isTableFocusedRef.current = isTableFocused;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isTableFocusedRef.current) return;

      const container = containerRef?.current || keyboardContainerRef.current;
      if (!container) return;

      const tag = document.activeElement?.tagName;
      const isEditingCell =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;

      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "a" &&
        !isEditingCell
      ) {
        const indices =
          selectableRowIndices && selectableRowIndices.length > 0
            ? selectableRowIndices
            : totalRows > 0
              ? Array.from({ length: totalRows }, (_, i) => i)
              : [];

        if (indices.length === 0) return;

        e.preventDefault();
        e.stopPropagation();
        setSelectedRows(new Set(indices));
        setSelectedRowIndex(indices[0] ?? null);
        setLastSelectedRow(indices[indices.length - 1] ?? null);
        container.focus();
        return;
      }

      if (
        e.key === "Backspace" &&
        !isEditingCell &&
        selectedRows.size > 0
      ) {
        e.preventDefault();
        e.stopPropagation();

        const rowsToDelete = Array.from(selectedRows).filter(
          (idx) =>
            !deletedRows.has(idx) && (!isNewRow || !isNewRow(idx))
        );

        rowsToDelete.forEach((idx) => onDeleteRow?.(idx));

        setSelectedRows(new Set());
        setSelectedRowIndex(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    selectedRows,
    deletedRows,
    onDeleteRow,
    isNewRow,
    containerRef,
    totalRows,
    selectableRowIndices,
  ]);

  const handleRowSelect = useCallback(
    (rowIndex: number, multi?: boolean, range?: boolean) => {
      setSelectedRowIndex(rowIndex);

      if (range && lastSelectedRow !== null) {
        const min = Math.min(lastSelectedRow, rowIndex);
        const max = Math.max(lastSelectedRow, rowIndex);
        setSelectedRows((prev) => {
          const newSelection = new Set(prev);
          for (let i = min; i <= max; i++) {
            newSelection.add(i);
          }
          return newSelection;
        });
      } else if (multi) {
        setSelectedRows((prev) => {
          const newSelection = new Set(prev);
          if (newSelection.has(rowIndex)) {
            newSelection.delete(rowIndex);
          } else {
            newSelection.add(rowIndex);
          }
          return newSelection;
        });
        setLastSelectedRow(rowIndex);
      } else {
        setSelectedRows(new Set([rowIndex]));
        setLastSelectedRow(rowIndex);
      }

      const container = containerRef?.current || keyboardContainerRef.current;
      container?.focus();
    },
    [containerRef, lastSelectedRow]
  );

  const handleColSelect = useCallback((colIndex: number) => {
    setSelectedColIndex(colIndex);
  }, []);

  return {
    selectedRowIndex,
    selectedRows,
    selectedColIndex,
    keyboardContainerRef,
    setSelectedRowIndex,
    setSelectedRows,
    setSelectedColIndex,
    handleRowSelect,
    handleColSelect,
  };
}
