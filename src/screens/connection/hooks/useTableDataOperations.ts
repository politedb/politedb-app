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

export function buildNewRowPatch(
  columns: Array<{ name: string }>,
  rowKey = `new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
) {
  const data: Record<string, unknown> = { __rowKey: rowKey };
  for (const column of columns) data[column.name] = null;
  return data;
}

export function useTableDataOperations({
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
    (rowIndex: number, _offset: number, rowKeyOverride?: string) => {
      if (isLocked) return;
      const rowKey = rowKeyOverride ?? String(rowIndex);
      const store = useConnectionStore.getState();
      const windowPatches =
        store.dataPatchMap[profileId]?.[activeTableWindowId]?.patches ?? null;

      // Unsaved rows exist only in create patches. Removing one must not mutate
      // the loaded row cache, which contains authoritative database rows.
      if (windowPatches?.create?.data?.[rowKey]) {
        store.removeDataPatch(
          profileId,
          activeTableWindowId,
          DATA_ACTIONS.create,
          DATA_KEYS.data,
          rowKey
        );
        return;
      }

      onDataChange?.(DATA_ACTIONS.delete, DATA_KEYS.data, rowIndex, {});
    },
    [isLocked, activeTableWindowId, onDataChange, profileId]
  );

  const handleAddRow = useCallback(
    (
      columns: Array<{ name: string }>,
      _rowIndex: number,
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

      // New rows have one authoritative representation: the create patch.
      // The table derives its visible new rows from these patches.
      if (onDataChange) {
        onDataChange(
          DATA_ACTIONS.create,
          DATA_KEYS.data,
          -1,
          buildNewRowPatch(columns)
        );
      }
    },
    [isLocked]
  );

  return {
    handleCellChange,
    handleDeleteRow,
    handleAddRow,
  };
}
