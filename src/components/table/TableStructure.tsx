import { useMemo, useCallback, useEffect } from "preact/hooks";
import type {
  DatabaseEngine,
  ForeignKeyInfo,
  TableStructure,
  TableWindow,
} from "src/types";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Input, InputOption } from "src/components/common/Input";
import { cn } from "src/utils/cn";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { getDbConfig, supportsForeignKeyEditing } from "src/utils/dbConfig";
import { useTableStructureOperations } from "src/screens/connection/hooks/useTableStructureOperations";
import { useTableRowSelection } from "src/screens/connection/hooks/useTableRowSelection";
import { useTableFocusState } from "src/hooks/useTableFocusState";
import {
  EDITABLE_TABLE_CELL_CLASS,
  selectionRowClass,
  tableMutationRowClass,
} from "./selectionClasses";
import { ArrowRightIcon } from "src/components/icons";
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
    ref: containerRef,
    rootRef,
    isFocused: isTableFocused,
  } = useTableFocusState();

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

  const handleDoubleClickRow = useCallback(
    (_row: any, index: number) => {
      if (readOnly) return;
      if (searchQuery.trim()) return;
      if (index >= tableData.length) onAddNewRecord();
    },
    [readOnly, searchQuery, tableData.length, onAddNewRecord]
  );

  const tableDataWithRowNumber = useMemo(
    () =>
      tableData.map(
        (row, index) =>
          ({
            ...row,
            _rowNumber: index + 1,
            _sourceIndex: index,
          }) as TableStructure & { _rowNumber?: number; _sourceIndex: number }
      ),
    [tableData]
  );

  const dbConfig = getDbConfig(engine);
  const allowForeignKeyEditing = supportsForeignKeyEditing(engine);

  const visibleColumns = useMemo(
    () =>
      COLUMNS_NAME.filter(
        (name) => name !== "foreign_key" || allowForeignKeyEditing
      ),
    [allowForeignKeyEditing]
  );

  const filteredTableData = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return tableDataWithRowNumber;

    return tableDataWithRowNumber.filter((row) =>
      visibleColumns.some((column) =>
        String(row[column] ?? "")
          .toLowerCase()
          .includes(normalizedQuery)
      )
    );
  }, [searchQuery, tableDataWithRowNumber, visibleColumns]);

  const selectableRowIndices = useMemo(
    () =>
      filteredTableData
        .map((row) => row._sourceIndex)
        .filter(
          (index): index is number => typeof index === "number" && index >= 0
        ),
    [filteredTableData]
  );

  const { selectedRowIndex, selectedRows, handleRowSelect, handleColSelect } =
    useTableRowSelection({
      onDeleteRow: (rowIndex) => handleDeleteRecord(rowIndex, deletedRows),
      deletedRows,
      containerRef: rootRef,
      totalRows: tableData.length,
      selectableRowIndices,
      isTableFocused,
    });

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

  const tableColumns = useMemo<
    CommonTableColumn<
      TableStructure & { _rowNumber?: number; _sourceIndex: number }
    >[]
  >(
    () => [
      {
        key: "_rowNumber",
        label: "#",
        sortable: true,
        sortKey: "_rowNumber",
        className: "min-w-12! text-center",
        headerClassName: "min-w-12! text-center",
        render: (_value: any, row: any, index: number) =>
          typeof row._sourceIndex === "number" ? (
            <span class="block w-full text-center text-sm text-neutral-500">
              {row._rowNumber ?? index + 1}
            </span>
          ) : (
            <></>
          ),
      },
      ...visibleColumns.map((name) => ({
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
          const colIndex = visibleColumns.indexOf(name);
          const showSelect = Object.keys(columnInputOptions).includes(name);
          const columnOptions = columnInputOptions[name];
          const isFkColumn = name === "foreign_key";
          const foreignKey = isFkColumn
            ? findFkForColumn(foreignKeys, row.column_name)
            : null;
          const fkLabel = foreignKey
            ? `${foreignKey?.ref_table_name}(${foreignKey?.ref_column_names})`
            : "";
          const rowPatch = structureUpdatePatches[String(sourceIndex)] ?? null;
          const hasForeignKeyPatch =
            !!rowPatch &&
            Object.prototype.hasOwnProperty.call(rowPatch, "foreign_key");
          const fkDisplayValue = hasForeignKeyPatch
            ? String(fieldValue)
            : String(fieldValue || fkLabel);
          const fkInitValue = String(initValue || fkLabel);
          const isNewRow =
            hasSourceIndex && (!initData || sourceIndex >= initData.length);
          const isDirtyCell = isFkColumn
            ? normalizeFkLabel(fkDisplayValue) !== normalizeFkLabel(fkInitValue)
            : initValue !== fieldValue;

          return (
            <div class="relative">
              <Input
                className={cn(
                  "h-8 cursor-default! rounded-xs text-sm text-ellipsis",
                  !isEmptyRow && EDITABLE_TABLE_CELL_CLASS,
                  isDirtyCell && !isNewRow && "bg-dirty",
                  isEmptyRow && "focus:bg-transparent! focus:outline-none",
                  selectionRowClass(
                    isRowSelected && !isEmptyRow,
                    isTableFocused
                  ),
                  isFkColumn && !isEmptyRow && "pr-6"
                )}
                showSelect={!isEmptyRow && showSelect}
                options={columnOptions}
                onValueChange={
                  showSelect
                    ? (value) => handleDataChange(sourceIndex, name, value)
                    : undefined
                }
                value={isFkColumn ? fkDisplayValue : String(fieldValue)}
                placeholder={placeholder}
                onInput={
                  !showSelect
                    ? (e) =>
                        handleDataChange(
                          sourceIndex,
                          name,
                          e.currentTarget.value
                        )
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
                  if (isFkColumn) {
                    openFkDialog(sourceIndex);
                    input.blur();
                    return;
                  }
                  input.focus();
                  input.select();
                }}
                disabled={busy || isDeleted || readOnly}
                readOnly={isEmptyRow || isDeleted || readOnly}
              />

              {!isEmptyRow && isFkColumn && (
                <button
                  type="button"
                  aria-label="Edit foreign key"
                  onClick={(e) => {
                    if (readOnly) return;
                    e.stopPropagation();
                    openFkDialog(sourceIndex);
                  }}
                  class={cn(
                    "absolute top-1/2 right-2 z-50 -translate-y-1/2",
                    readOnly
                      ? "cursor-not-allowed text-neutral-300"
                      : "text-neutral-400 hover:text-neutral-600"
                  )}
                  disabled={readOnly}
                >
                  <ArrowRightIcon className="size-3" />
                </button>
              )}
            </div>
          );
        },
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      visibleColumns,
      initData,
      deletedRows,
      selectedRows,
      columnInputOptions,
      findFkForColumn,
      foreignKeys,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      JSON.stringify(structureUpdatePatches),
      isTableFocused,
      busy,
      readOnly,
      handleDataChange,
      handleRowSelect,
      handleColSelect,
      openFkDialog,
    ]
  );

  return (
    <div
      ref={containerRef}
      class="table-focus-root h-full w-full outline-none"
      tabIndex={0}
      onMouseDown={(e) => {
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
          return tableMutationRowClass(
            deletedRows.has(index),
            !initData || index >= initData.length
          );
        }}
        onSelectRow={(_row, index, multi, range) => {
          handleRowSelect(index, multi, range);
        }}
        onDoubleClickRow={handleDoubleClickRow}
        selectionFocused={isTableFocused}
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
