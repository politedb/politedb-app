import { useCallback, useState } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import type { ForeignKeyInfo, TableStructure } from "src/types";
import { DATA_KEYS } from "src/constant";

/** Find an existing FK that references the given column (column_names may be comma-separated). */

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
  const [fkRowIndex, setFkRowIndex] = useState<number | null>(null);

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

  const findFkForColumn = useCallback(
    (foreignKeys: ForeignKeyInfo[] | null, columnName: string) => {
      if (!foreignKeys?.length || !columnName?.trim()) return null;
      const key = columnName.trim();
      return (
        foreignKeys.find((fk) =>
          fk.column_names
            .split(",")
            .map((s) => s.trim())
            .includes(key)
        ) ?? null
      );
    },
    []
  );

  const getEditingFk = useCallback(
    (foreignKeys: ForeignKeyInfo[] | null) => {
      if (fkRowIndex == null) return null;
      const row = editedData[fkRowIndex];
      const columnName = row?.column_name ?? "";
      return findFkForColumn(foreignKeys ?? null, columnName);
    },
    [fkRowIndex, editedData]
  );

  const getFkColumnName = useCallback(() => {
    if (fkRowIndex == null) return "";
    return editedData[fkRowIndex]?.column_name ?? "";
  }, [fkRowIndex, editedData]);

  const openFkDialog = useCallback((rowIndex: number) => {
    setFkRowIndex(rowIndex);
  }, []);

  const closeFkDialog = useCallback(() => {
    setFkRowIndex(null);
  }, []);

  const saveForeignKey = useCallback(
    (draft: Partial<ForeignKeyInfo>) => {
      // Update the structure row's foreign_key cell so it participates in the normal patch/save flow.
      const labelParts: string[] = [];
      const refTable = draft.ref_table_name;
      const refCols = draft.ref_column_names;

      if (refTable) labelParts.push(refTable);
      if (refCols) labelParts.push(`(${refCols})`);

      const foreignKeyLabel = labelParts.join("");

      if (foreignKeyLabel && fkRowIndex != null) {
        handleDataChange(fkRowIndex, "foreign_key", foreignKeyLabel);
      }

      closeFkDialog();
    },
    [fkRowIndex, handleDataChange]
  );

  return {
    fkRowIndex,
    findFkForColumn,
    getEditingFk,
    getFkColumnName,
    openFkDialog,
    closeFkDialog,
    saveForeignKey,
    handleDataChange,
    handleDeleteRecord,
    handleAddNewRecord,
  };
}
