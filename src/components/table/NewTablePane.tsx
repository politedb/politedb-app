import { useEffect, useMemo } from "preact/hooks";
import { Input, InputOption } from "src/components/common/Input";
import { Button } from "src/components/common/Button";
import {
  SchemaCanvasTable,
  type SchemaCanvasColumn,
} from "./SchemaCanvasTable";
import { PlusIcon } from "src/components/icons";
import type { TableItem, DatabaseEngine, TableColumn } from "src/types";
import { useCreateSchemaTable } from "src/hooks/useCreateSchemaTable";
import { useConnectionStore } from "src/stores/connection";
import { TableViewToggle } from "./TableViewToggle";
import { TagSelect } from "src/components/common/TagSelect";
import { useNewTableState } from "src/hooks/useNewTableState";
import { getDbConfig } from "src/utils/dbConfig";

const COLUMN_PROPERTIES: (keyof TableColumn)[] = [
  "column_name",
  "data_type",
  "is_nullable",
  "column_default",
];

interface Props {
  activeSchema: string;
  table: TableItem;
  engine: DatabaseEngine;
  activeProfileScreen: string;
  tableWindowId: string;
  isProfileLocked?: boolean;
  onSuccess?: (tableName: string) => void;
  onSaveRef?: (saveFn: () => Promise<void>) => void;
}

export function NewTablePane({
  activeSchema,
  engine,
  activeProfileScreen,
  tableWindowId,
  isProfileLocked = false,
  onSuccess,
  onSaveRef,
}: Props) {
  const { busy } = useCreateSchemaTable();
  const setNewTableData = useConnectionStore((s) => s.setNewTableData);

  // Load saved data from store
  const savedData = useConnectionStore((s) => {
    if (!activeProfileScreen || !tableWindowId) return null;
    return s.newTableData[activeProfileScreen]?.[tableWindowId] ?? null;
  });

  const tableState = useNewTableState({
    schema: activeSchema,
    activeProfileScreen: activeProfileScreen,
    initialData: savedData,
    activeWindowId: tableWindowId,
    isProfileLocked,
    onSuccess,
  });

  useEffect(() => {
    if (!activeProfileScreen || !tableWindowId) return;
    setNewTableData(activeProfileScreen, tableWindowId, {
      tableName: tableState.tableName,
      primaryKey: tableState.primaryKey,
      columns: tableState.columns,
    });
  }, [
    activeProfileScreen,
    tableWindowId,
    tableState.tableName,
    tableState.primaryKey,
    tableState.columns,
    setNewTableData,
  ]);

  // Expose save function to parent via ref
  useEffect(() => {
    if (onSaveRef) {
      onSaveRef(tableState.handleSave);
    }
  }, [tableState.handleSave, onSaveRef]);

  const dbConfig = getDbConfig(engine);

  const columnOptions = useMemo(
    () =>
      ({
        data_type: dbConfig.dataTypes.map((type) => ({
          label: type,
          value: type,
        })),
        is_nullable: [
          { label: "YES", value: "YES" },
          { label: "NO", value: "NO" },
        ],
      }) as Record<keyof TableColumn, InputOption[]>,
    [dbConfig]
  );

  const tableColumns = useMemo<SchemaCanvasColumn<TableColumn>[]>(
    () =>
      COLUMN_PROPERTIES.map((key) => ({
        key,
        options: columnOptions[key]?.map((option) =>
          typeof option === "string" ? { label: option, value: option } : option
        ),
      })),
    [columnOptions]
  );

  return (
    <div class="flex h-full flex-1 flex-col bg-white">
      {/* Header */}
      <div class="border-t border-b border-neutral-200 bg-neutral-50 p-2">
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2">
            <label class="text-xs font-semibold text-neutral-700">Name</label>
            <Input
              value={tableState.tableName}
              onInput={(e) => tableState.setTableName(e.currentTarget.value)}
              placeholder="table_name"
              className="h-7 border border-neutral-200 bg-white py-1 text-sm"
              disabled={busy || isProfileLocked}
            />
          </div>
          <div class="flex flex-1 items-center gap-2">
            <label class="text-xs font-semibold text-neutral-700">
              Primary
            </label>
            <TagSelect
              className="w-full"
              values={tableState.primaryKey}
              onChange={tableState.togglePrimaryKey}
              options={tableState.columnNames}
              enableSearch
              disabled={isProfileLocked}
            />
          </div>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        <SchemaCanvasTable
          rows={tableState.columns}
          columns={tableColumns}
          readOnly={busy || isProfileLocked}
          isNewRow={() => true}
          onChange={tableState.updateColumn}
          onDelete={tableState.removeColumn}
          onAdd={() => tableState.addColumn(null, tableState.columns.length)}
        />
      </div>

      {/* Footer */}
      <div class="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-[9.25px]">
        <div class="flex items-center gap-1.5">
          <TableViewToggle viewMode="structure" />

          <Button variant="shadow" className="px-2" disabled>
            <PlusIcon className="size-3" />
            Index
          </Button>

          <Button
            variant="shadow"
            className="px-2"
            disabled={isProfileLocked}
            onClick={() =>
              tableState.addColumn(null, tableState.columns.length)
            }
          >
            <PlusIcon className="size-3" />
            Column
          </Button>
        </div>
      </div>
    </div>
  );
}
