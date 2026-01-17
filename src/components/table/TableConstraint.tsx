import { useMemo, useCallback, useRef } from "preact/hooks";
import type { TableConstraint } from "src/types";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Input } from "src/components/common/Input";
import { cn } from "src/utils/cn";
import { DataAction, DataKey } from "src/stores/connection";
import { useTableConstraintOperations } from "src/screens/connection/hooks/useTableConstraintOperations";
import { useTableRowSelection } from "src/screens/connection/hooks/useTableRowSelection";

const COLUMNS_NAME: (keyof TableConstraint)[] = [
  "index_name",
  "index_algorithm",
  "is_unique",
  "column_name",
  "condition",
  "include",
  "comment",
];

interface Props {
  initData: TableConstraint[] | null;
  activeProfileScreen: string;
  activeTableWindowId: string;
  busy: boolean;
  error: string | null;
  editedData: TableConstraint[];
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

export function TableConstraints({
  initData,
  activeProfileScreen,
  activeTableWindowId,
  busy,
  error,
  editedData,
  onAddNewRecord,
  onDeleteRecord,
  deletedRows = new Set(),
  onDataChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Use constraint operations hook
  const { handleDataChange, handleDeleteRecord } = useTableConstraintOperations(
    {
      activeProfileScreen,
      activeTableWindowId,
      initData,
      editedData,
      onDataChange,
      onDeleteRecord,
    }
  );

  // Use row selection hook
  const { selectedRowIndex, handleRowSelect } = useTableRowSelection({
    onDeleteRow: handleDeleteRecord,
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

  const tableColumns = useMemo<CommonTableColumn<TableConstraint>[]>(
    () => [
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
              className={cn(
                "cursor-default! text-sm",
                isEmptyRow && "focus:bg-transparent focus:outline-none"
              )}
              value={String(fieldValue ?? "")}
              placeholder={placeholder}
              onInput={(e) =>
                handleDataChange(index, name, e.currentTarget.value)
              }
              onMouseDown={(e) => {
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
    [busy, editedData.length, handleDataChange, deletedRows, onDeleteRecord]
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
        emptyMessage="No constraints data available"
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
