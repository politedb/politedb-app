import { useState, useEffect, useRef, useCallback } from "preact/hooks";

export interface UseTableRowSelectionProps {
  onDeleteRow?: (rowIndex: number) => void;
  deletedRows?: Set<number>;
  isNewRow?: (rowIndex: number) => boolean;
  containerRef?: { current: HTMLDivElement | null };
}

export function useTableRowSelection({
  onDeleteRow,
  deletedRows = new Set(),
  isNewRow,
  containerRef,
}: UseTableRowSelectionProps) {
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const keyboardContainerRef = useRef<HTMLDivElement>(null);

  // Handle keyboard events for row deletion
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle backspace if:
      // 1. Backspace key is pressed
      // 2. No input field is focused (user is not editing a cell)
      // 3. A row is selected
      // 4. The row is not already deleted
      // 5. The row is not a new row (if isNewRow function is provided)
      if (
        e.key === "Backspace" &&
        document.activeElement?.tagName !== "INPUT" &&
        selectedRowIndex !== null &&
        !deletedRows.has(selectedRowIndex) &&
        (!isNewRow || !isNewRow(selectedRowIndex))
      ) {
        e.preventDefault();
        e.stopPropagation();
        onDeleteRow?.(selectedRowIndex);
      }
    };

    const container = containerRef?.current || keyboardContainerRef.current;
    if (container) {
      container.addEventListener("keydown", handleKeyDown);
      return () => {
        container.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [selectedRowIndex, deletedRows, onDeleteRow, isNewRow, containerRef]);

  const handleRowSelect = useCallback(
    (rowIndex: number) => {
      setSelectedRowIndex(rowIndex);
      // Focus the container to enable keyboard events
      const container = containerRef?.current || keyboardContainerRef.current;
      container?.focus();
    },
    [containerRef]
  );

  return {
    selectedRowIndex,
    setSelectedRowIndex,
    handleRowSelect,
    keyboardContainerRef,
  };
}
