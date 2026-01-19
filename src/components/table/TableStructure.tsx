import { useMemo, useCallback, useRef } from "preact/hooks";
import type { DatabaseEngine, TableStructure } from "src/types";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Input } from "src/components/common/Input";
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
  const { selectedRowIndex, handleRowSelect } = useTableRowSelection({
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
    if (!editedData.length || error || busy) {
      return [];
    }
    return editedData;
  }, [editedData, error, busy]);

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
          ) : null,
      },
      ...COLUMNS_NAME.map((name) => ({
        key: name,
        label: name,
        render: (_value: any, row: any, index: number) => {
          const fieldValue = row[name];
          const isEmptyRow = index + 1 > editedData.length;
          const isDeleted = deletedRows.has(index);
          const placeholder = isEmptyRow ? "" : "NULL";
          const isRowSelected = selectedRowIndex === index;

          return (
            <Input
              showSelect={!isEmptyRow && name === "data_type"}
              options={DATA_TYPES[engine].map((type) => ({
                label: type,
                value: type,
              }))}
              onValueChange={
                name === "data_type"
                  ? (value) => handleDataChange(index, name, value)
                  : undefined
              }
              className={cn(
                "cursor-default! text-sm",
                isEmptyRow && "focus:bg-transparent focus:outline-none"
              )}
              value={String(fieldValue ?? "")}
              placeholder={placeholder}
              onInput={
                name !== "data_type"
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
                  const input = e.currentTarget as HTMLInputElement;
                  input.select();
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
      handleDataChange,
      deletedRows,
      onDeleteRecord,
      engine,
      selectedRowIndex,
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
        emptyMessage="No structure data available"
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
