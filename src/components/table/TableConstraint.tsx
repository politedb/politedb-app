import { useMemo, useCallback, useRef } from "preact/hooks";
import type { DatabaseEngine, TableConstraint } from "src/types";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Input, InputOption } from "src/components/common/Input";
import { cn } from "src/utils/cn";
import { DataAction, DataKey } from "src/stores/connection";
import { useTableConstraintOperations } from "src/screens/connection/hooks/useTableConstraintOperations";
import { useTableRowSelection } from "src/screens/connection/hooks/useTableRowSelection";
import { getDbConfig } from "src/utils/dbConfig";

const COLUMNS_NAME: Record<DatabaseEngine, (keyof TableConstraint)[]> = {
  postgres: [
    "index_name",
    "index_algorithm",
    "is_unique",
    "column_name",
    "condition",
    "include",
    "comment",
  ],
  mysql: ["index_name", "index_algorithm", "is_unique", "column_name"],
  mariadb: ["index_name", "index_algorithm", "is_unique", "column_name"],
  mongo: ["index_name", "index_algorithm", "is_unique", "column_name"],
  redis: [],
  sqlserver: ["index_name", "index_algorithm", "is_unique", "column_name"],
  sqlite: ["index_name", "index_algorithm", "is_unique", "column_name"],
  oracle: ["index_name", "index_algorithm", "is_unique", "column_name"],
};

interface Props {
  initData: TableConstraint[] | null;
  columnNames: string[];
  activeProfileScreen: string;
  activeTableWindowId: string;
  busy: boolean;
  error: string | null;
  editedData: TableConstraint[];
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
  engine: DatabaseEngine;
  searchQuery?: string;
}

export function TableConstraints({
  initData,
  columnNames,
  activeProfileScreen,
  activeTableWindowId,
  busy,
  error,
  editedData,
  readOnly = false,
  onAddNewRecord,
  onDeleteRecord,
  deletedRows = new Set(),
  onDataChange,
  engine,
  searchQuery = "",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Use constraint operations hook
  const { handleDataChange, handleDeleteRecord } = useTableConstraintOperations(
    {
      activeProfileScreen,
      activeTableWindowId,
      initData,
      editedData,
      isLocked: readOnly,
      onDataChange,
      onDeleteRecord,
    }
  );

  // Use row selection hook
  const {
    selectedRowIndex,
    selectedRows,
    handleRowSelect,
    selectedColIndex,
    handleColSelect,
  } = useTableRowSelection({
    onDeleteRow: handleDeleteRecord,
    deletedRows,
    containerRef: containerRef,
  });

  const handleDoubleClickRow = useCallback(
    (_row: any, index: number) => {
      if (readOnly) return;
      if (searchQuery.trim()) return;
      // Check if it's an empty row (index >= editedData.length)
      if (index >= editedData.length) {
        onAddNewRecord();
      }
    },
    [readOnly, searchQuery, editedData.length, onAddNewRecord]
  );

  const tableData = useMemo(() => {
    if (error) return [];
    if (editedData.length > 0) return editedData;
    return initData ?? [];
  }, [editedData, initData, error]);

  const searchableTableData = useMemo(
    () =>
      tableData.map(
        (row, index) =>
          ({ ...row, _sourceIndex: index }) as TableConstraint & {
            _sourceIndex: number;
          }
      ),
    [tableData]
  );

  const filteredTableData = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return searchableTableData;

    return searchableTableData.filter((row) =>
      COLUMNS_NAME[engine].some((column) =>
        String(row[column] ?? "")
          .toLowerCase()
          .includes(normalizedQuery)
      )
    );
  }, [searchQuery, searchableTableData, engine]);

  const dbConfig = getDbConfig(engine);

  const columnInputOptions = useMemo(
    () =>
      ({
        index_algorithm: dbConfig.indexAlgorithms.map((type) => ({
          label: type,
          value: type,
        })),
        is_unique: [
          { label: "TRUE", value: "true" },
          { label: "FALSE", value: "false" },
        ],
        column_name: columnNames.map((name) => ({
          label: name,
          value: name,
        })),
      }) as Record<keyof TableConstraint, InputOption[]>,
    [dbConfig]
  );

  const tableColumns = useMemo<
    CommonTableColumn<TableConstraint & { _sourceIndex: number }>[]
  >(
    () => [
      ...COLUMNS_NAME[engine].map((name) => ({
        key: name,
        label: name,
        sortable: true,
        sortKey: name,
        className: "px-0",
        render: (_value: any, row: any, _index: number) => {
          const hasSourceIndex = typeof row._sourceIndex === "number";
          const sourceIndex = hasSourceIndex ? row._sourceIndex : -1;
          const initValue = initData?.[sourceIndex]?.[name] ?? "";
          const fieldValue = row[name] ?? "";
          const isEmptyRow = !hasSourceIndex;
          const isDeleted = deletedRows.has(sourceIndex);
          const placeholder = isEmptyRow ? "" : "NULL";
          const isRowSelected = selectedRows.has(sourceIndex);
          const colIndex = COLUMNS_NAME[engine].indexOf(name);
          const showSelect = Object.keys(columnInputOptions).includes(name);
          const columnOptions = columnInputOptions[name];

          return (
            <Input
              className={cn(
                "h-8 cursor-default! rounded-[2px] text-sm text-ellipsis focus:bg-white!",
                initValue !== fieldValue && "bg-amber-200",
                isEmptyRow && "focus:bg-transparent! focus:outline-none",
                isRowSelected && !isEmptyRow && "bg-blue-200!"
              )}
              showSelect={!isEmptyRow && showSelect}
              options={columnOptions}
              onValueChange={
                showSelect
                  ? (value) => handleDataChange(sourceIndex, name, value)
                  : undefined
              }
              value={String(fieldValue)}
              placeholder={placeholder}
              onInput={
                !showSelect
                  ? (e) =>
                      handleDataChange(sourceIndex, name, e.currentTarget.value)
                  : undefined
              }
              onMouseDown={(e) => {
                if (!isRowSelected && !isEmptyRow && !isDeleted) {
                  e.preventDefault();
                }
              }}
              onClick={(e) => {
                if (readOnly) return;
                if (isRowSelected) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (selectedColIndex !== colIndex) {
                    const input = e.currentTarget as HTMLInputElement;
                    input.select();
                    handleColSelect(colIndex);
                  }
                }
              }}
              disabled={busy || isDeleted || readOnly}
              readOnly={isEmptyRow || isDeleted || readOnly}
            />
          );
        },
      })),
    ],
    [
      busy,
      editedData.length,
      deletedRows,
      selectedRows,
      selectedRowIndex,
      selectedColIndex,
      handleDataChange,
      onDeleteRecord,
      initData,
      readOnly,
    ]
  );

  return (
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
        data={filteredTableData}
        rowIndexExtractor={(row) => row._sourceIndex}
        stickyHeader
        fillViewport
        showEmptyMessage={false}
        selectedRow={selectedRowIndex}
        selectedRows={selectedRows}
        rowClassName={(_row, index) => {
          return deletedRows.has(index) ? "bg-red-300!" : "";
        }}
        onSelectRow={(_row, index, multi, range) => {
          handleRowSelect(index, multi, range);
        }}
        onDoubleClickRow={handleDoubleClickRow}
      />
    </div>
  );
}
