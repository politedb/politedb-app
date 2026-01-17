import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "preact/hooks";
import type { DatabaseEngine, TableStructure } from "src/types";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Input } from "src/components/common/Input";
import { cn } from "src/utils/cn";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { DATA_KEYS, DATA_TYPES } from "../../constant";

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
  const setEditedData = useConnectionStore((s) => s.updateTableStructure);
  const setTableStructure = useConnectionStore((s) => s.setTableStructure);
  const removeDataPatch = useConnectionStore((s) => s.removeDataPatch);

  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDataChange = useCallback(
    (
      rowIndex: number,
      field: keyof TableStructure,
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
      onDataChange?.(action, DATA_KEYS.structure, rowIndex, {
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
      if (
        e.key === "Backspace" &&
        document.activeElement?.tagName !== "INPUT" &&
        selectedRow !== null &&
        !deletedRows.has(selectedRow) &&
        selectedRow < editedData.length
      ) {
        e.preventDefault();
        e.stopPropagation();

        // Check if the row is new (not in initData)
        const isNewRow = !initData || selectedRow >= initData.length;

        if (isNewRow) {
          // For new rows, remove from editedData directly without storing delete action
          const newEditedData = editedData.filter(
            (_, index) => index !== selectedRow
          );
          setTableStructure(
            activeProfileScreen,
            activeTableWindowId,
            newEditedData
          );

          // Remove the create patch for this row since it was never actually created
          const rowKey = String(selectedRow);
          removeDataPatch(
            activeProfileScreen,
            activeTableWindowId,
            "create",
            DATA_KEYS.structure,
            rowKey
          );

          // Clear selection if the deleted row was selected
          setSelectedRow(null);
        } else {
          // For existing rows, mark as deleted (will create a delete patch)
          onDeleteRecord?.(selectedRow);
        }
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("keydown", handleKeyDown);
      return () => {
        container.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [
    selectedRow,
    deletedRows,
    onDeleteRecord,
    editedData,
    editedData.length,
    initData,
    activeProfileScreen,
    activeTableWindowId,
    setTableStructure,
    removeDataPatch,
  ]);

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
            <span class="text-xs text-neutral-500">{index + 1}</span>
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
          const isRowSelected = selectedRow === index;

          return (
            <Input
              showSelect={!isEmptyRow && name === "data_type"}
              options={DATA_TYPES[engine].map((type) => ({
                label: type,
                value: type,
              }))}
              className={cn(
                "cursor-default!",
                isEmptyRow && "focus:bg-transparent focus:outline-none"
              )}
              value={String(fieldValue ?? "")}
              placeholder={placeholder}
              onInput={(e) =>
                handleDataChange(index, name, e.currentTarget.value)
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
      selectedRow,
      engine,
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
