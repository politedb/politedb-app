import { useMemo, useCallback, useRef } from "preact/hooks";
import type { DatabaseEngine, TableStructure } from "src/types";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Input, InputOption } from "src/components/common/Input";
import { cn } from "src/utils/cn";
import { DataAction, DataKey } from "src/stores/connection";
import { DATA_TYPES } from "src/constant";
import { useTableStructureOperations } from "src/screens/connection/hooks/useTableStructureOperations";
import { useTableRowSelection } from "src/screens/connection/hooks/useTableRowSelection";

const COLUMNS_NAME: (keyof TableStructure)[] = [
  "column_name",
  "data_type",
  "is_nullable",
  "column_default",
  "foreign_key",
  "comment",
];

interface Props {
  initData: TableStructure[] | null;
  activeProfileScreen: string;
  activeTableWindowId: string;
  busy: boolean;
  error: string | null;
  engine: DatabaseEngine;
  editedData: TableStructure[];
  onAddNewRecord: () => void;
  onDeleteRecord?: (rowIndex: number) => void;
  deletedRows?: Set<number>;
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
}

export function TableStructure({
  initData,
  activeProfileScreen,
  activeTableWindowId,
  busy,
  error,
  editedData = [],
  onAddNewRecord,
  onDeleteRecord,
  deletedRows = new Set(),
  onDataChange,
  engine,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Use structure operations hook
  const { handleDataChange, handleDeleteRecord } = useTableStructureOperations({
    activeProfileScreen,
    activeTableWindowId,
    initData,
    editedData,
    onDataChange,
    onDeleteRecord,
  });

  // Use row selection hook
  const {
    selectedRowIndex,
    handleRowSelect,
    selectedColIndex,
    handleColSelect,
  } = useTableRowSelection({
    onDeleteRow: (rowIndex) => handleDeleteRecord(rowIndex, deletedRows),
    deletedRows,
    containerRef: containerRef,
  });

  const handleDoubleClickRow = useCallback(
    (_row: any, index: number) => {
      // Check if it's an empty row (index >= editedData.length)
      if (index >= editedData.length) {
        onAddNewRecord();
      }
    },
    [editedData.length, onAddNewRecord]
  );

  const tableData = useMemo(() => {
    if (error) return [];
    if (editedData.length > 0) return editedData;
    return initData ?? [];
  }, [editedData, initData, error]);

  const columnInputOptions = useMemo(
    () => ({
      data_type: DATA_TYPES[engine].map((type) => ({
        label: type,
        value: type,
      })),
      is_nullable: [
        { label: "TRUE", value: "true" },
        { label: "FALSE", value: "false" },
      ],
    }),
    [engine]
  ) as Record<keyof TableStructure, InputOption[]>;

  const tableColumns = useMemo<
    CommonTableColumn<TableStructure & { _rowNumber?: number }>[]
  >(
    () => [
      {
        key: "_rowNumber",
        label: "#",
        className: "min-w-12! text-center",
        headerClassName: "min-w-12! text-center",
        render: (_value: any, _row: any, index: number) =>
          index + 1 <= editedData.length ? (
            <span class="text-sm text-neutral-500">{index + 1}</span>
          ) : (
            <></>
          ),
      },
      ...COLUMNS_NAME.map((name) => ({
        key: name,
        label: name,
        className: "px-0",
        render: (_value: any, row: any, index: number) => {
          const initValue = initData?.[index]?.[name] ?? "";
          const fieldValue = row[name] ?? "";
          const isEmptyRow = index + 1 > editedData.length;
          const isDeleted = deletedRows.has(index);
          const placeholder = isEmptyRow ? "" : "NULL";
          const isRowSelected = selectedRowIndex === index;
          const colIndex = COLUMNS_NAME.indexOf(name);
          const showSelect = Object.keys(columnInputOptions).includes(name);
          const columnOptions = columnInputOptions[name];

          return (
            <Input
              className={cn(
                "h-8 cursor-default! rounded-none text-sm text-ellipsis focus:bg-white!",
                initValue !== fieldValue && "bg-amber-100",
                isEmptyRow && "focus:bg-transparent! focus:outline-none",
                isRowSelected && !isEmptyRow && "bg-blue-200!"
              )}
              showSelect={!isEmptyRow && showSelect}
              options={columnOptions}
              onValueChange={
                showSelect
                  ? (value) => handleDataChange(index, name, value)
                  : undefined
              }
              value={String(fieldValue)}
              placeholder={placeholder}
              onInput={
                !showSelect
                  ? (e) => handleDataChange(index, name, e.currentTarget.value)
                  : undefined
              }
              onMouseDown={(e) => {
                // Prevent input focus if row is not selected yet
                // This allows first click to select row, second click to focus input
                if (!isRowSelected && !isEmptyRow && !isDeleted) {
                  e.preventDefault();
                }
              }}
              onClick={(e) => {
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
              disabled={busy || isDeleted}
              readOnly={isEmptyRow || isDeleted}
            />
          );
        },
      })),
    ],
    [
      busy,
      editedData.length,
      deletedRows,
      selectedRowIndex,
      selectedColIndex,
      handleDataChange,
      onDeleteRecord,
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
        data={tableData}
        stickyHeader
        fillViewport
        showEmptyMessage={false}
        selectedRow={selectedRowIndex}
        rowClassName={(_row, index) => {
          return deletedRows.has(index) ? "bg-red-300!" : "";
        }}
        onSelectRow={(_row, index) => {
          handleRowSelect(index);
        }}
        onDoubleClickRow={handleDoubleClickRow}
      />
    </div>
  );
}
