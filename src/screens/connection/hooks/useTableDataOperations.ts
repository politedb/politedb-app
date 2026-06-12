import { useCallback } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { DATA_ACTIONS, DATA_KEYS } from "src/constant";

export interface UseTableDataOperationsProps {
  activeKey: string;
  profileId: string;
  activeTableWindowId: string;
  isLocked?: boolean;
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
}

export function useTableDataOperations({
  activeKey,
  profileId,
  activeTableWindowId,
  isLocked = false,
  onDataChange,
}: UseTableDataOperationsProps) {
  const handleCellChange = useCallback(
    (
      action: DataAction,
      rowIndex: number,
      data: Record<string, any>,
      isNewRow: boolean,
      rowKey?: string
    ) => {
      if (isLocked) return;
      const dataKey: DataKey = "data";
      const changeData: Record<string, any> = { ...data };

      // Include rowKey for new rows
      if (isNewRow && rowKey) {
        changeData.__rowKey = rowKey;
      }

      onDataChange?.(action, dataKey, isNewRow ? -1 : rowIndex, changeData);
    },
    [isLocked, onDataChange]
  );

  const handleDeleteRow = useCallback(
    (rowIndex: number, offset: number, rowKeyOverride?: string) => {
      if (isLocked) return;
      const rowKey = rowKeyOverride ?? String(rowIndex);
      const store = useConnectionStore.getState();
      const windowPatches =
        store.dataPatchMap[profileId]?.[activeTableWindowId]?.patches ?? null;

      // If this row is a new row (only in create patch), remove the create patch
      // and the row from the store so we don't generate INSERT + DELETE SQL
      if (windowPatches?.create?.data?.[rowKey]) {
        store.removeDataPatch(
          profileId,
          activeTableWindowId,
          DATA_ACTIONS.create,
          DATA_KEYS.data,
          rowKey
        );
        const globalRowIndex = offset + rowIndex;
        store.removeRow(activeKey, globalRowIndex);
        return;
      }

      onDataChange?.(DATA_ACTIONS.delete, DATA_KEYS.data, rowIndex, {});
    },
    [isLocked, activeKey, activeTableWindowId, onDataChange, profileId]
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
      if (isLocked) return;
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
    [isLocked, activeKey]
  );

  return {
    handleCellChange,
    handleDeleteRow,
    handleAddRow,
  };
}
