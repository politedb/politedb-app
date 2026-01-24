import { useCallback } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { DATA_ACTIONS, DATA_KEYS } from "src/constant";

export interface UseTableDataOperationsProps {
  activeKey: string;
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onDeleteRow?: (rowIndex: number) => void;
}

export function useTableDataOperations({
  activeKey,
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
      rowIndex: number,
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
      const newRowKey = rowIndex.toString();

      // Initialize the new row with empty values for all columns
      const newRowData: Record<string, any> = {};
      columns.forEach((col) => {
        newRowData[col.name] = null;
      });

      // Add the row to the store (always use current activeKey so we don't add to the wrong table when switching)
      useConnectionStore
        .getState()
        .addRow(activeKey, Object.values(newRowData));

      // Create the new row patch with action="create"
      if (onDataChange) {
        onDataChange(DATA_ACTIONS.create, DATA_KEYS.data, -1, {
          ...newRowData,
          __rowKey: newRowKey,
        });
      }
    },
    [activeKey]
  );

  return {
    handleCellChange,
    handleDeleteRow,
    handleAddRow,
  };
}
