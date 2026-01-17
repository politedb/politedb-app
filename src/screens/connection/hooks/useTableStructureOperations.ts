import { useCallback } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import type { TableStructure } from "src/types";
import { DATA_KEYS } from "src/constant";

export interface UseTableStructureOperationsProps {
  activeProfileScreen: string;
  activeTableWindowId: string;
  initData: TableStructure[] | null;
  editedData: TableStructure[];
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onDeleteRecord?: (rowIndex: number) => void;
}

export function useTableStructureOperations({
  activeProfileScreen,
  activeTableWindowId,
  initData,
  editedData,
  onDataChange,
  onDeleteRecord,
}: UseTableStructureOperationsProps) {
  const setEditedData = useConnectionStore((s) => s.updateTableStructure);
  const setTableStructure = useConnectionStore((s) => s.setTableStructure);
  const removeDataPatch = useConnectionStore((s) => s.removeDataPatch);

  const handleDataChange = useCallback(
    (
      rowIndex: number,
      field: keyof TableStructure,
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
      onDataChange?.(action, DATA_KEYS.structure, rowIndex, {
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
    (rowIndex: number, _deletedRows: Set<number>) => {
      // Check if the row is new (not in initData)
      const isNewRow = !initData || rowIndex >= initData.length;

      if (isNewRow) {
        // For new rows, remove from editedData directly without storing delete action
        const newEditedData = editedData.filter(
          (_, index) => index !== rowIndex
        );
        setTableStructure(
          activeProfileScreen,
          activeTableWindowId,
          newEditedData
        );

        // Remove the create patch for this row since it was never actually created
        const rowKey = String(rowIndex);
        removeDataPatch(
          activeProfileScreen,
          activeTableWindowId,
          "create",
          DATA_KEYS.structure,
          rowKey
        );
      } else {
        // For existing rows, mark as deleted (will create a delete patch)
        onDeleteRecord?.(rowIndex);
      }
    },
    [
      initData,
      editedData,
      activeProfileScreen,
      activeTableWindowId,
      setTableStructure,
      removeDataPatch,
      onDeleteRecord,
    ]
  );

  const handleAddNewRecord = useCallback(
    (onAddNewRecord: () => void, newRecord: TableStructure) => {
      setTableStructure(activeProfileScreen, activeTableWindowId, [
        ...editedData,
        newRecord,
      ]);

      onDataChange?.(
        "create",
        DATA_KEYS.structure,
        editedData.length,
        newRecord
      );

      onAddNewRecord();
    },
    [
      activeProfileScreen,
      activeTableWindowId,
      editedData,
      setTableStructure,
      onDataChange,
    ]
  );

  return {
    handleDataChange,
    handleDeleteRecord,
    handleAddNewRecord,
  };
}
