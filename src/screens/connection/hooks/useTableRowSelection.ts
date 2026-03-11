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
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null); // Kept for backwards compatibility
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [lastSelectedRow, setLastSelectedRow] = useState<number | null>(null);
  
  const [selectedColIndex, setSelectedColIndex] = useState<number | null>(null);
  const keyboardContainerRef = useRef<HTMLDivElement>(null);

  // Handle keyboard events for row deletion
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle backspace if:
      // 1. Backspace key is pressed
      // 2. No input field is focused (user is not editing a cell)
      // 3. At least one row is selected
      if (
        e.key === "Backspace" &&
        document.activeElement?.tagName !== "INPUT" &&
        selectedRows.size > 0
      ) {
        e.preventDefault();
        e.stopPropagation();
        
        const rowsToDelete = Array.from(selectedRows).filter(idx => 
          !deletedRows.has(idx) && (!isNewRow || !isNewRow(idx))
        );
        
        rowsToDelete.forEach(idx => onDeleteRow?.(idx));
        
        setSelectedRows(new Set());
        setSelectedRowIndex(null);
      }
    };

    const container = containerRef?.current || keyboardContainerRef.current;
    if (container) {
      container.addEventListener("keydown", handleKeyDown);
      return () => {
        container.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [selectedRows, deletedRows, onDeleteRow, isNewRow, containerRef]);

  const handleRowSelect = useCallback(
    (rowIndex: number, multi?: boolean, range?: boolean) => {
      setSelectedRowIndex(rowIndex);
      
      if (range && lastSelectedRow !== null) {
        // Shift click
        const min = Math.min(lastSelectedRow, rowIndex);
        const max = Math.max(lastSelectedRow, rowIndex);
        setSelectedRows(prev => {
           const newSelection = new Set(prev);
           for (let i = min; i <= max; i++) {
              newSelection.add(i);
           }
           return newSelection;
        });
      } else if (multi) {
        // Ctrl/Cmd click
        setSelectedRows(prev => {
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
        // Normal click
        setSelectedRows(new Set([rowIndex]));
        setLastSelectedRow(rowIndex);
      }

      // Focus the container to enable keyboard events
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
