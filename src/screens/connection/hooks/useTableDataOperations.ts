import { useCallback } from "preact/hooks";
import { DataAction, DataKey } from "src/stores/connection";

export interface UseTableDataOperationsProps {
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onDeleteRow?: (rowIndex: number) => void;
}

export function useTableDataOperations({
  onDataChange,
  onDeleteRow,
}: UseTableDataOperationsProps) {
  const handleCellChange = useCallback(
    (
      action: DataAction,
      rowIndex: number,
      data: Record<string, any>,
      isNewRow: boolean,
      rowKey?: string
    ) => {
      const dataKey: DataKey = "data";
      const changeData: Record<string, any> = { ...data };

      // Include rowKey for new rows
      if (isNewRow && rowKey) {
        changeData.__rowKey = rowKey;
      }

      onDataChange?.(action, dataKey, isNewRow ? -1 : rowIndex, changeData);
    },
    [onDataChange]
  );

  const handleDeleteRow = useCallback(
    (rowIndex: number) => {
      onDeleteRow?.(rowIndex);
    },
    [onDeleteRow]
  );

  const handleAddRow = useCallback(
    (
      columns: Array<{ name: string }>,
      onDataChange?: (
        action: DataAction,
        dataKey: DataKey,
        rowIndex: number,
        data: Record<string, any>
      ) => void
    ) => {
      if (!columns || columns.length === 0) {
        console.warn("handleAddRow: columns is missing or empty");
        return;
      }

      // Generate a unique row key for the new row
      const newRowKey = `new-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`;

      // Initialize the new row with empty values for all columns
      const newRowData: Record<string, any> = {};
      columns.forEach((col) => {
        newRowData[col.name] = null;
      });

      // Create the new row patch with action="create"
      if (onDataChange) {
        onDataChange("create", "data", -1, {
          ...newRowData,
          __rowKey: newRowKey,
        });
      }
    },
    []
  );

  return {
    handleCellChange,
    handleDeleteRow,
    handleAddRow,
  };
}
