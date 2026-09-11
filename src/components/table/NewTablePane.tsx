import { useEffect, useMemo } from "preact/hooks";
import { Input, InputOption } from "src/components/common/Input";
import { Button } from "src/components/common/Button";
import { Table } from "src/components/common/Table";
import { PlusIcon } from "src/components/icons";
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
import { useTableFocusState } from "src/hooks/useTableFocusState";
import {
  ACTIVE_TABLE_CELL_CLASS,
  EDITABLE_TABLE_CELL_CLASS,
  selectionRowClass,
} from "./selectionClasses";

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
  const {
    ref: containerRef,
    rootRef,
    isFocused: isTableFocused,
  } = useTableFocusState();

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
  const {
    selectedRowIndex,
    selectedRows,
    selectedColIndex,
    handleRowSelect,
    handleColSelect,
  } = useTableRowSelection({
    onDeleteRow: (rowIndex) => tableState.removeColumn(rowIndex),
    containerRef: rootRef,
    totalRows: tableState.columns.length,
    isTableFocused,
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
      COLUMN_PROPERTIES.map((colKey, colIndex) => ({
        key: colKey,
        label: colKey,
        className: "px-0",
        render: (_, row, index) => {
          const isEmptyRow = index + 1 > tableState.columns.length;
          const isRowSelected = selectedRows.has(index);
          const placeholder = isEmptyRow ? "" : "NULL";
          const showSelect = Object.keys(columnOptions).includes(colKey);

          return (
            <Input
              className={cn(
                "h-8 cursor-default! rounded-none text-sm",
                !isEmptyRow && EDITABLE_TABLE_CELL_CLASS,
                isEmptyRow
                  ? "focus:bg-transparent focus:outline-none"
                  : "bg-new!",
                selectionRowClass(isRowSelected && !isEmptyRow, isTableFocused),
                selectedRowIndex === index &&
                  selectedColIndex === colIndex &&
                  ACTIVE_TABLE_CELL_CLASS
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
                if (!isEmptyRow) {
                  e.preventDefault();
                }
              }}
              onClick={(e) => {
                if (isProfileLocked || isEmptyRow) return;

                handleColSelect(colIndex);

                const multi = e.metaKey || e.ctrlKey;
                const range = e.shiftKey;
                if (
                  !multi &&
                  !range &&
                  selectedRows.size > 1 &&
                  isRowSelected
                ) {
                  handleRowSelect(index);
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDblClick={(e) => {
                if (isEmptyRow || isProfileLocked) return;

                e.preventDefault();
                e.stopPropagation();

                if (!isRowSelected) {
                  handleRowSelect(index);
                }

                handleColSelect(colIndex);
                const input = e.currentTarget as HTMLInputElement;
                input.focus();
                input.select();
              }}
              disabled={busy || isProfileLocked}
              readOnly={isEmptyRow || isProfileLocked}
            />
          );
        },
      })),
    [
      tableState,
      selectedRows,
      selectedRowIndex,
      selectedColIndex,
      columnOptions,
      isTableFocused,
      busy,
      isProfileLocked,
      handleRowSelect,
      handleColSelect,
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

      {/* Column Definition Table */}
      <div class="flex-1 overflow-hidden">
        <div
          ref={containerRef}
          class="table-focus-root h-full w-full outline-none"
          tabIndex={0}
          onMouseDown={(e) => {
            // Focus container when clicking to enable keyboard events
            if (
              e.target === e.currentTarget ||
              (e.target as HTMLElement).closest("table")
            ) {
              rootRef.current?.focus();
            }
          }}
        >
          <Table
            columns={tableColumns}
            data={tableState.columns}
            fillViewport
            stickyHeader
            showEmptyMessage={false}
            selectedRow={selectedRowIndex}
            selectedRows={selectedRows}
            selectionFocused={isTableFocused}
            onDoubleClickRow={tableState.addColumn}
            onSelectRow={(_row, index, multi, range) =>
              handleRowSelect(index, multi, range)
            }
          />
        </div>
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
