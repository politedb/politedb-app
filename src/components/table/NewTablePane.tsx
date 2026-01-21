import { useEffect } from "preact/hooks";
import { Input } from "src/components/common/Input";
import { Button } from "src/components/common/Button";
import { Table } from "src/components/common/Table";
import { Plus } from "src/components/icons";
import type { TableItem, DatabaseEngine } from "src/types";
import { useCreateSchemaTable } from "src/hooks/useCreateSchemaTable";
import { useConnectionStore } from "src/stores/connection";
import { TableViewToggle } from "./TableViewToggle";
import { TagSelect } from "src/components/common/TagSelect";
import { useNewTableState } from "src/hooks/useNewTableState";
import { useNewTableColumns } from "./hooks/useNewTableColumns";

interface Props {
  activeSchema: string;
  table: TableItem;
  engine: DatabaseEngine;
  activeProfileScreen: string;
  tableWindowId: string;
  onSuccess?: (tableName: string) => void;
  onSaveRef?: (saveFn: () => Promise<void>) => void;
}

export function NewTablePane({
  activeSchema,
  engine,
  activeProfileScreen,
  tableWindowId,
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
    onSuccess,
  });

  const tableColumns = useNewTableColumns({
    columns: tableState.columns,
    busy,
    engine,
    onChange: tableState.updateColumn,
    onRemove: tableState.removeColumn,
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
              className="border border-neutral-200 bg-white text-xs"
              disabled={busy}
            />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-xs font-semibold text-neutral-700">
              Primary
            </label>
            <TagSelect
              values={tableState.primaryKey}
              onChange={tableState.togglePrimaryKey}
              options={tableState.columnNames}
            />
          </div>
        </div>
      </div>

      {/* Column Definition Table */}
      <div class="flex-1 overflow-auto">
        <div class="min-w-full">
          <Table
            columns={tableColumns}
            data={tableState.columns}
            rowClassName="bg-green-200!"
            stickyHeader
            emptyMessage="No columns defined"
          />
        </div>
      </div>

      {/* Footer */}
      <div class="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-[9.25px]">
        <div class="flex items-center gap-1.5">
          <TableViewToggle viewMode="structure" />

          <Button variant="shadow" className="px-2" disabled>
            <Plus className="size-3.5" />
            Index
          </Button>

          <Button
            variant="shadow"
            className="px-2"
            onClick={tableState.addColumn}
          >
            <Plus className="size-3.5" />
            Column
          </Button>
        </div>
      </div>
    </div>
  );
}
