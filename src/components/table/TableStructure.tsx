import { useMemo, useCallback, useEffect } from "preact/hooks";
import type {
  DatabaseEngine,
  ForeignKeyInfo,
  TableStructure,
  TableWindow,
} from "src/types";
import {
  SchemaCanvasTable,
  type SchemaCanvasColumn,
} from "./SchemaCanvasTable";
import type { InputOption } from "src/components/common/Input";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { getDbConfig, supportsForeignKeyEditing } from "src/utils/dbConfig";
import { useTableStructureOperations } from "src/screens/connection/hooks/useTableStructureOperations";
import { ForeignKeyDialog } from "src/components/modal/ForeignKeyDialog";

const COLUMNS_NAME: (keyof TableStructure)[] = [
  "column_name",
  "data_type",
  "is_nullable",
  "column_default",
  "foreign_key",
  "comment",
];

function normalizeFkLabel(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, "")
    .trim();
}

interface Props {
  initData: TableStructure[] | null;
  foreignKeys: ForeignKeyInfo[] | null;
  activeProfileScreen: string;
  activeTableWindow: TableWindow;
  busy: boolean;
  error: string | null;
  engine: DatabaseEngine;
  editedData: TableStructure[];
  readOnly?: boolean;
  onAddNewRecord: () => void;
  onDeleteRecord?: (rowIndex: number) => void;
  deletedRows?: Set<number>;
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  tableList?: { schema: string; name: string }[];
  searchQuery?: string;
}

export function TableStructure({
  initData,
  foreignKeys,
  activeProfileScreen,
  activeTableWindow,
  busy,
  error,
  editedData = [],
  readOnly = false,
  onAddNewRecord,
  onDeleteRecord,
  deletedRows = new Set(),
  onDataChange,
  engine,
  tableList = [],
  searchQuery = "",
}: Props) {
  const {
    fkRowIndex,
    getEditingFk,
    getFkColumnName,
    findFkForColumn,
    openFkDialog,
    closeFkDialog,
    saveForeignKey,
    deleteForeignKey,
    handleDataChange,
    handleDeleteRecord,
  } = useTableStructureOperations({
    activeProfileScreen,
    activeTableWindowId: activeTableWindow.id,
    initData,
    editedData,
    isLocked: readOnly,
    onDataChange,
    onDeleteRecord,
  });

  const tableData = useMemo(() => {
    if (error) return [];
    if (editedData.length > 0) return editedData;
    return initData ?? [];
  }, [editedData, initData, error]);

  const dbConfig = getDbConfig(engine);
  const allowForeignKeyEditing = supportsForeignKeyEditing(engine);

  const visibleColumns = useMemo(
    () =>
      COLUMNS_NAME.filter(
        (name) => name !== "foreign_key" || allowForeignKeyEditing
      ),
    [allowForeignKeyEditing]
  );

  useEffect(() => {
    if (!allowForeignKeyEditing && fkRowIndex !== null) {
      closeFkDialog();
    }
  }, [allowForeignKeyEditing, fkRowIndex, closeFkDialog]);

  const columnInputOptions = useMemo(
    () => ({
      data_type: dbConfig.dataTypes.map((type) => ({
        label: type,
        value: type,
      })),
      is_nullable: [
        { label: "TRUE", value: "true" },
        { label: "FALSE", value: "false" },
      ],
    }),
    [dbConfig]
  ) as Record<keyof TableStructure, InputOption[]>;

  const dataPatchMap = useConnectionStore(
    (s) => s.dataPatchMap[activeProfileScreen]
  );
  const structureUpdatePatches = useMemo(
    () =>
      dataPatchMap?.[activeTableWindow.id]?.patches?.update?.structure ?? {},
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeTableWindow.id,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      dataPatchMap?.[activeTableWindow.id]?.patches?.update?.structure,
    ]
  );

  const getValue = useCallback(
    (row: TableStructure, name: keyof TableStructure, index: number) => {
      if (name !== "foreign_key") return row[name] ?? "";
      const patch = structureUpdatePatches[String(index)];
      if (patch && Object.prototype.hasOwnProperty.call(patch, "foreign_key"))
        return row[name] ?? "";
      const fk = findFkForColumn(foreignKeys, row.column_name);
      return (
        row[name] || (fk ? `${fk.ref_table_name}(${fk.ref_column_names})` : "")
      );
    },
    [structureUpdatePatches, findFkForColumn, foreignKeys]
  );

  const tableColumns = useMemo<SchemaCanvasColumn<TableStructure>[]>(
    () =>
      visibleColumns.map((key) => ({
        key,
        options: columnInputOptions[key]?.map((option) =>
          typeof option === "string" ? { label: option, value: option } : option
        ),
        action: key === "foreign_key" ? openFkDialog : undefined,
      })),
    [visibleColumns, columnInputOptions, openFkDialog]
  );

  return (
    <div class="h-full w-full">
      <SchemaCanvasTable
        rows={tableData}
        columns={tableColumns}
        searchQuery={searchQuery}
        readOnly={readOnly || busy}
        deletedRows={deletedRows}
        getValue={getValue}
        isNewRow={(index) => !initData || index >= initData.length}
        isCellDirty={(index, name) => {
          const row = tableData[index];
          if (!row) return false;
          const current = getValue(row, name, index);
          if (name !== "foreign_key")
            return (initData?.[index]?.[name] ?? "") !== current;
          const original = initData?.[index];
          const fk = findFkForColumn(foreignKeys, row.column_name);
          const initial =
            original?.[name] ||
            (fk ? `${fk.ref_table_name}(${fk.ref_column_names})` : "");
          return normalizeFkLabel(initial) !== normalizeFkLabel(current);
        }}
        onChange={handleDataChange}
        onDelete={(index) => handleDeleteRecord(index, deletedRows)}
        onAdd={onAddNewRecord}
      />

      {allowForeignKeyEditing && fkRowIndex !== null && (
        <ForeignKeyDialog
          open={true}
          onClose={closeFkDialog}
          fk={getEditingFk(foreignKeys)}
          tableName={activeTableWindow.table.name}
          schema={activeTableWindow.table.schema}
          tableList={tableList}
          originColumn={getFkColumnName()}
          activeScreen={activeProfileScreen}
          onDelete={
            readOnly
              ? undefined
              : getEditingFk(foreignKeys)
                ? deleteForeignKey
                : undefined
          }
          onSave={readOnly ? () => {} : saveForeignKey}
        />
      )}
    </div>
  );
}
