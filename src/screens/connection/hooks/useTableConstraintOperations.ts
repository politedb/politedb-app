import { useCallback } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import type { TableConstraint } from "src/types";
import { DATA_KEYS } from "src/constant";

export interface UseTableConstraintOperationsProps {
  activeProfileScreen: string;
  activeTableWindowId: string;
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
    [
      initData?.length,
      activeProfileScreen,
      activeTableWindowId,
      setEditedData,
      onDataChange,
    ]
  );

  const handleDeleteRecord = useCallback(
    (rowIndex: number) => {
      // For constraints, always mark as deleted (will create a delete patch)
      onDeleteRecord?.(rowIndex);
    },
    [onDeleteRecord]
  );

  const handleAddNewRecord = useCallback(
    (onAddNewRecord: () => void, newRecord: TableConstraint) => {
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
