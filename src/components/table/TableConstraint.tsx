import { useMemo, useCallback } from "preact/hooks";
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
import { useTableFocusState } from "src/hooks/useTableFocusState";
import { selectionRowClass } from "./selectionClasses";
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
  cassandra: ["index_name", "index_algorithm", "is_unique", "column_name"],
  redis: [],
  sqlserver: ["index_name", "index_algorithm", "is_unique", "column_name"],
  sqlite: ["index_name", "index_algorithm", "is_unique", "column_name"],
  d1: ["index_name", "index_algorithm", "is_unique", "column_name"],
  turso: ["index_name", "index_algorithm", "is_unique", "column_name"],
  oracle: ["index_name", "index_algorithm", "is_unique", "column_name"],
  snowflake: ["index_name", "index_algorithm", "is_unique", "column_name"],
  duckdb: ["index_name", "index_algorithm", "is_unique", "column_name"],
  clickhouse: ["index_name", "index_algorithm", "is_unique", "column_name"],
  google_sheets: [],
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
  const {
    ref: containerRef,
    rootRef,
    isFocused: isTableFocused,
  } = useTableFocusState();

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

  const selectableRowIndices = useMemo(
    () =>
      filteredTableData
        .map((row) => row._sourceIndex)
        .filter(
          (index): index is number => typeof index === "number" && index >= 0
        ),
    [filteredTableData]
  );

  // Use row selection hook
  const { selectedRowIndex, selectedRows, handleRowSelect, handleColSelect } =
    useTableRowSelection({
      onDeleteRow: handleDeleteRecord,
      deletedRows,
      containerRef: rootRef,
      totalRows: tableData.length,
      selectableRowIndices,
      isTableFocused,
    });

  const handleDoubleClickRow = useCallback(
    (_row: any, index: number) => {
      if (readOnly) return;
      if (searchQuery.trim()) return;
      if (index >= tableData.length) {
        onAddNewRecord();
      }
    },
    [readOnly, searchQuery, tableData.length, onAddNewRecord]
  );

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
    [columnNames, dbConfig.indexAlgorithms]
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
          const isNewRow =
            hasSourceIndex && (!initData || sourceIndex >= initData.length);
          const isDeleted = deletedRows.has(sourceIndex);
          const placeholder = isEmptyRow ? "" : "NULL";
          const isRowSelected = selectedRows.has(sourceIndex);
          const colIndex = COLUMNS_NAME[engine].indexOf(name);
          const showSelect = Object.keys(columnInputOptions).includes(name);
          const columnOptions = columnInputOptions[name];
          const isDirtyCell = initValue !== fieldValue;

          return (
            <Input
              className={cn(
                "h-8 cursor-default! rounded-xs text-sm text-ellipsis focus:bg-white!",
                isDirtyCell && !isNewRow && "bg-dirty",
                isEmptyRow && "focus:bg-transparent! focus:outline-none",
                selectionRowClass(isRowSelected && !isEmptyRow, isTableFocused)
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
                if (!isEmptyRow && !isDeleted) {
                  e.preventDefault();
                }
              }}
              onClick={(e) => {
                if (readOnly) return;

                const multi = e.metaKey || e.ctrlKey;
                const range = e.shiftKey;
                if (
                  !multi &&
                  !range &&
                  selectedRows.size > 1 &&
                  isRowSelected
                ) {
                  handleRowSelect(sourceIndex);
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDblClick={(e) => {
                if (readOnly || isEmptyRow || isDeleted) return;

                e.preventDefault();
                e.stopPropagation();

                if (!isRowSelected) {
                  handleRowSelect(sourceIndex);
                }

                handleColSelect(colIndex);
                const input = e.currentTarget as HTMLInputElement;
                input.focus();
                input.select();
              }}
              disabled={busy || isDeleted || readOnly}
              readOnly={isEmptyRow || isDeleted || readOnly}
            />
          );
        },
      })),
    ],
    [
      engine,
      initData,
      deletedRows,
      selectedRows,
      columnInputOptions,
      isTableFocused,
      busy,
      readOnly,
      handleDataChange,
      handleRowSelect,
      handleColSelect,
    ]
  );

  return (
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
        data={filteredTableData}
        rowIndexExtractor={(row) => row._sourceIndex}
        stickyHeader
        fillViewport
        showEmptyMessage={false}
        selectedRow={selectedRowIndex}
        selectedRows={selectedRows}
        rowClassName={(_row, index) => {
          return deletedRows.has(index) ? "bg-deleted!" : "";
        }}
        onSelectRow={(_row, index, multi, range) => {
          handleRowSelect(index, multi, range);
        }}
        onDoubleClickRow={handleDoubleClickRow}
        selectionFocused={isTableFocused}
      />
    </div>
  );
}
