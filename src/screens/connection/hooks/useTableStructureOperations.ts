import { useCallback, useState } from "preact/hooks";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import type { ForeignKeyInfo, TableStructure } from "src/types";
import { DATA_KEYS } from "src/constant";

/** Find an existing FK that references the given column (column_names may be comma-separated). */

export interface UseTableStructureOperationsProps {
  activeProfileScreen: string;
  activeTableWindowId: string;
  isLocked?: boolean;
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
  isLocked = false,
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
      onDataChange?.(action, DATA_KEYS.structure, rowIndex, {
        [field]: value,
      });
    },
    [
      isLocked,
      initData?.length,
      activeProfileScreen,
      activeTableWindowId,
      setEditedData,
      onDataChange,
    ]
  );

  const handleDeleteRecord = useCallback(
    (rowIndex: number, _deletedRows: Set<number>) => {
      if (isLocked) return;
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
      isLocked,
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
      if (isLocked) return;
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
      isLocked,
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

  const parseForeignKeyLabel = useCallback((label: unknown) => {
    if (typeof label !== "string") return null;
    const raw = label.trim();
    if (!raw) return null;

    // Supports: "ref_table(ref_col)" or "ref_schema.ref_table(ref_col)"
    const match = raw.match(/^([\w.]+)\s*\(([^)]+)\)\s*$/);
    if (!match) return null;

    const tablePart = (match[1] ?? "").trim();
    const refColumn = (match[2] ?? "")
      .split(",")[0]
      ?.trim();
    if (!tablePart || !refColumn) return null;

    let refSchema = "";
    let refTable = tablePart;
    const parts = tablePart.split(".");
    if (parts.length === 2) {
      refSchema = parts[0] ?? "";
      refTable = parts[1] ?? "";
    }

    return {
      ref_table_schema: refSchema,
      ref_table_name: refTable,
      ref_column_names: refColumn,
    };
  }, []);

  const getEditingFk = useCallback(
    (foreignKeys: ForeignKeyInfo[] | null) => {
      if (fkRowIndex == null) return null;
      const row = editedData[fkRowIndex];
      const columnName = row?.column_name ?? "";
      const rowPatch =
        useConnectionStore.getState().dataPatchMap[activeProfileScreen]?.[
          activeTableWindowId
        ]?.patches?.update?.structure?.[String(fkRowIndex)] ?? null;
      const hasForeignKeyPatch =
        !!rowPatch &&
        Object.prototype.hasOwnProperty.call(rowPatch, "foreign_key");

      if (
        hasForeignKeyPatch &&
        typeof row?.foreign_key === "string" &&
        row.foreign_key.trim() === ""
      ) {
        return null;
      }

      const existing = findFkForColumn(foreignKeys ?? null, columnName);
      const parsed = parseForeignKeyLabel(row?.foreign_key);
      if (!parsed) return existing;

      return {
        constraint_name: existing?.constraint_name ?? "",
        table_schema: existing?.table_schema ?? "",
        table_name: existing?.table_name ?? "",
        column_names: existing?.column_names ?? columnName,
        ref_table_schema: parsed.ref_table_schema || existing?.ref_table_schema || "",
        ref_table_name: parsed.ref_table_name,
        ref_column_names: parsed.ref_column_names,
        on_update: existing?.on_update ?? "NO ACTION",
        on_delete: existing?.on_delete ?? "NO ACTION",
      } as ForeignKeyInfo;
    },
    [
      fkRowIndex,
      editedData,
      findFkForColumn,
      parseForeignKeyLabel,
      activeProfileScreen,
      activeTableWindowId,
    ]
  );

  const getFkColumnName = useCallback(() => {
    if (fkRowIndex == null) return "";
    return editedData[fkRowIndex]?.column_name ?? "";
  }, [fkRowIndex, editedData]);

  const openFkDialog = useCallback((rowIndex: number) => {
    if (isLocked) return;
    setFkRowIndex(rowIndex);
  }, [isLocked]);

  const closeFkDialog = useCallback(() => {
    setFkRowIndex(null);
  }, []);

  const saveForeignKey = useCallback(
    (draft: Partial<ForeignKeyInfo>) => {
      if (isLocked) return;
      // Update the structure row's foreign_key cell so it participates in the normal patch/save flow.
      const labelParts: string[] = [];
      const refTable = draft.ref_table_name;
      const refCols = draft.ref_column_names;

      if (refTable) labelParts.push(refTable);
      if (refCols) labelParts.push(`(${refCols})`);

      const foreignKeyLabel = labelParts.join("");

      if (fkRowIndex != null) {
        handleDataChange(fkRowIndex, "foreign_key", foreignKeyLabel);
      }

      closeFkDialog();
    },
    [isLocked, fkRowIndex, handleDataChange, closeFkDialog]
  );

  const deleteForeignKey = useCallback(() => {
    if (isLocked) return;
    if (fkRowIndex == null) return;
    handleDataChange(fkRowIndex, "foreign_key", "");
    closeFkDialog();
  }, [isLocked, fkRowIndex, handleDataChange, closeFkDialog]);

  return {
    fkRowIndex,
    findFkForColumn,
    getEditingFk,
    getFkColumnName,
    openFkDialog,
    closeFkDialog,
    saveForeignKey,
    deleteForeignKey,
    handleDataChange,
    handleDeleteRecord,
    handleAddNewRecord,
  };
}
