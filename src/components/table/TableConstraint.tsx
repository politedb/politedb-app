import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "preact/hooks";
import type { TableConstraint } from "src/types";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Input } from "src/components/common/Input";
import { cn } from "src/utils/cn";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { DATA_KEYS } from "src/constant";

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
  const setEditedData = useConnectionStore((s) => s.updateTableConstraints);

  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDataChange = useCallback(
    (
      rowIndex: number,
      field: keyof TableConstraint,
      value: string | boolean
    ) => {
      setEditedData(
        activeProfileScreen,
        activeTableWindowId,
        rowIndex,
        field,
        value
      );

      const isNewRow = !initData || rowIndex >= initData.length;
      const action = isNewRow ? "create" : "update";
      onDataChange?.(action, DATA_KEYS.constraints, rowIndex, {
        [field]: value,
      });
    },
    [
      initData?.length,
      activeProfileScreen,
      activeTableWindowId,
      setEditedData,
      onDataChange,
    ]
  );

  const handleDoubleClickRow = useCallback(
    (_row: any, index: number) => {
      // Check if it's an empty row (index >= editedData.length)
      if (index >= editedData.length) {
        onAddNewRecord();
      }
    },
    [editedData.length, onAddNewRecord]
  );

  // Handle keyboard events for row deletion
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle backspace if:
      // 1. Backspace key is pressed
      // 2. No input field is focused (user is not editing a cell)
      // 3. A row is selected
      // 4. The row is not already deleted
      // 5. The row is not a new row (empty row)
      if (
        e.key === "Backspace" &&
        document.activeElement?.tagName !== "INPUT" &&
        selectedRow !== null &&
        !deletedRows.has(selectedRow) &&
        selectedRow < editedData.length
      ) {
        e.preventDefault();
        e.stopPropagation();
        onDeleteRecord?.(selectedRow);
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("keydown", handleKeyDown);
      return () => {
        container.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [selectedRow, deletedRows, onDeleteRecord, editedData.length]);

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

          return (
            <Input
              className={cn(
                isEmptyRow && "focus:bg-transparent focus:outline-none"
              )}
              value={String(fieldValue ?? "")}
              placeholder={placeholder}
              onInput={(e) =>
                handleDataChange(index, name, e.currentTarget.value)
              }
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
        selectedRow={selectedRow}
        rowClassName={(_row, index) => {
          return deletedRows.has(index) ? "bg-red-300!" : "";
        }}
        onSelectRow={(_row, index) => {
          setSelectedRow(index);
          // Focus container to enable keyboard events
          containerRef.current?.focus();
        }}
        onDoubleClickRow={handleDoubleClickRow}
      />
    </div>
  );
}
