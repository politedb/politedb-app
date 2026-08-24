import { useCallback } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { DATA_ACTIONS, DATA_KEYS } from "src/constant";
import { defaultCellEditValue } from "src/lib/table-data/cellEditValue";
import type { ColumnMeta } from "src/lib/tauri/types";

export interface UseTableDataOperationsProps {
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
  columns: Pick<ColumnMeta, "name" | "column_default" | "auto_generated">[],
  existingRowKeys: readonly string[]
) {
  const usedKeys = new Set(existingRowKeys);
  let rowNumber = existingRowKeys.length;
  while (usedKeys.has(`new:${rowNumber}`)) rowNumber += 1;

  const data: Record<string, unknown> = {};
  for (const column of columns) {
    const hasDatabaseDefault =
      column.auto_generated === true ||
      (typeof column.column_default === "string" &&
        column.column_default.trim() !== "");
    data[column.name] = hasDatabaseDefault ? defaultCellEditValue() : null;
  }

  return { rowKey: `new:${rowNumber}`, data };
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
    (
      rowIndex: number,
      offsetOrRowKey?: number | string,
      rowKeyOverride?: string
    ) => {
      if (isLocked) return;
      const rowKey =
        rowKeyOverride ??
        (typeof offsetOrRowKey === "string"
          ? offsetOrRowKey
          : String(rowIndex));
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
      columns: Pick<ColumnMeta, "name" | "column_default" | "auto_generated">[],
      _rowIndex?: number,
      onDataChangeOverride?: (
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
      const emitDataChange = onDataChangeOverride ?? onDataChange;
      if (emitDataChange) {
        const store = useConnectionStore.getState();
        const existingRowKeys = Object.keys(
          store.dataPatchMap[profileId]?.[activeTableWindowId]?.patches?.create
            ?.data ?? {}
        );
        const { rowKey, data } = buildNewRowPatch(columns, existingRowKeys);
        emitDataChange(DATA_ACTIONS.create, DATA_KEYS.data, -1, {
          ...data,
          __rowKey: rowKey,
        });
      }
    },
    [activeTableWindowId, isLocked, onDataChange, profileId]
  );

  return {
    handleCellChange,
    handleDeleteRow,
    handleAddRow,
  };
}
