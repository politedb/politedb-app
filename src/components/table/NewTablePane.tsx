import { useEffect, useMemo, useRef } from "preact/hooks";
import { Input, InputOption } from "src/components/common/Input";
import { Button } from "src/components/common/Button";
import { Table } from "src/components/common/Table";
import { Plus } from "src/components/icons";
import type { TableItem, DatabaseEngine, TableColumn } from "src/types";
import type { TableColumn as CommonColumn } from "src/components/common/Table";
import { useCreateSchemaTable } from "src/hooks/useCreateSchemaTable";
import { useConnectionStore } from "src/stores/connection";
import { TableViewToggle } from "./TableViewToggle";
import { TagSelect } from "src/components/common/TagSelect";
import { useNewTableState } from "src/hooks/useNewTableState";
import { getDbConfig } from "src/utils/dbConfig";
import { cn } from "src/utils/cn";
import { useTableRowSelection } from "src/screens/connection/hooks/useTableRowSelection";

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
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Use row selection hook
  const { selectedRowIndex, handleRowSelect } = useTableRowSelection({
    onDeleteRow: (rowIndex) => tableState.removeColumn(rowIndex),
    containerRef: containerRef,
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

  const tableColumns = useMemo<CommonColumn<TableColumn>[]>(
    () =>
      COLUMN_PROPERTIES.map((colKey) => ({
        key: colKey,
        label: colKey,
        className: "px-0",
        render: (_, row, index) => {
          const isEmptyRow = index + 1 > tableState.columns.length;
          const isRowSelected = selectedRowIndex === index;
          const placeholder = isEmptyRow ? "" : "NULL";
          const showSelect = Object.keys(columnOptions).includes(colKey);

          return (
            <Input
              className={cn(
                "h-8 cursor-default! rounded-none text-sm",
                isEmptyRow
                  ? "focus:bg-transparent focus:outline-none"
                  : "bg-green-100! focus:bg-white!",
                isRowSelected && !isEmptyRow && "bg-blue-200!"
              )}
              showSelect={!isEmptyRow && showSelect}
              options={columnOptions[colKey]}
              value={row[colKey]}
              placeholder={placeholder}
              onValueChange={
                !isEmptyRow && showSelect
                  ? (value) => tableState.updateColumn(index, colKey, value)
                  : undefined
              }
              onInput={
                !showSelect
                  ? (e) =>
                      tableState.updateColumn(
                        index,
                        colKey,
                        e.currentTarget.value
                      )
                  : undefined
              }
              onMouseDown={(e) => {
                // Prevent input focus if row is not selected yet
                // This allows first click to select row, second click to focus input
                if (!isRowSelected && !isEmptyRow) {
                  e.preventDefault();
                }
              }}
              onClick={(e) => {
                if (isRowSelected) {
                  e.preventDefault();
                  e.stopPropagation();
                  const input = e.currentTarget as HTMLInputElement;
                  input.select();
                }
              }}
              disabled={busy || isProfileLocked}
              readOnly={isEmptyRow || isProfileLocked}
            />
          );
        },
      })),
    [
      tableState.columns.length,
      selectedRowIndex,
      busy,
      isProfileLocked,
      columnOptions,
      tableState.updateColumn,
    ]
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
              className="border border-neutral-200 bg-white text-xs"
              disabled={busy || isProfileLocked}
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
              disabled={isProfileLocked}
            />
          </div>
        </div>
      </div>

      {/* Column Definition Table */}
      <div class="flex-1 overflow-hidden">
        <div
          ref={containerRef}
          class="h-full w-full"
          tabIndex={0}
          onMouseDown={(e) => {
            // Focus container when clicking to enable keyboard events
            if (
              e.target === e.currentTarget ||
              (e.target as HTMLElement).closest("table")
            ) {
              containerRef.current?.focus();
            }
          }}
        >
          <Table
            columns={tableColumns}
            data={tableState.columns}
            fillViewport
            stickyHeader
            showEmptyMessage={false}
            onDoubleClickRow={tableState.addColumn}
            onSelectRow={(_row, index) => handleRowSelect(index)}
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
            disabled={isProfileLocked}
            onClick={() =>
              tableState.addColumn(null, tableState.columns.length)
            }
          >
            <Plus className="size-3.5" />
            Column
          </Button>
        </div>
      </div>
    </div>
  );
}
