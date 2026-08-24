import { useCallback } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import type { TableConstraint } from "src/types";
import { DATA_KEYS } from "src/constant";

export interface UseTableConstraintOperationsProps {
  activeProfileScreen: string;
  activeTableWindowId: string;
  isLocked?: boolean;
  initData: TableConstraint[] | null;
  editedData: TableConstraint[];
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onDeleteRecord?: (rowIndex: number) => void;
}

export function useTableConstraintOperations({
  activeProfileScreen,
  activeTableWindowId,
  isLocked = false,
  initData,
  editedData,
  onDataChange,
  onDeleteRecord,
}: UseTableConstraintOperationsProps) {
  const setEditedData = useConnectionStore((s) => s.updateTableConstraints);
  const setTableConstraints = useConnectionStore((s) => s.setTableConstraints);

  const handleDataChange = useCallback(
    (
      rowIndex: number,
      field: keyof TableConstraint,
      value: string | boolean
    ) => {
      if (isLocked) return;
      setEditedData(
        activeProfileScreen,
        activeTableWindowId,
        rowIndex,
        field,
        value
      );

      const isNewRow = !initData || rowIndex >= initData.length;
      const action = isNewRow ? "create" : "update";
      onDataChange?.(action, DATA_KEYS.constraints, rowIndex, {
        [field]: value,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      isLocked,
      setEditedData,
      activeProfileScreen,
      activeTableWindowId,
      initData?.length,
      onDataChange,
    ]
  );

  const handleDeleteRecord = useCallback(
    (rowIndex: number) => {
      if (isLocked) return;
      // For constraints, always mark as deleted (will create a delete patch)
      onDeleteRecord?.(rowIndex);
    },
    [isLocked, onDeleteRecord]
  );

  const handleAddNewRecord = useCallback(
    (onAddNewRecord: () => void, newRecord: TableConstraint) => {
      if (isLocked) return;
      setTableConstraints(activeProfileScreen, activeTableWindowId, [
        ...editedData,
        newRecord,
      ]);

      onDataChange?.(
        "create",
        DATA_KEYS.constraints,
        editedData.length,
        newRecord
      );

      onAddNewRecord();
    },
    [
      isLocked,
      activeProfileScreen,
      activeTableWindowId,
      editedData,
      setTableConstraints,
      onDataChange,
    ]
  );

  return {
    handleDataChange,
    handleDeleteRecord,
    handleAddNewRecord,
  };
}
