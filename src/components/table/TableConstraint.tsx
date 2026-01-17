import { useMemo, useState, useCallback } from "preact/hooks";
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
  onDataChange,
}: Props) {
  const setEditedData = useConnectionStore((s) => s.updateTableConstraints);

  const [selectedRow, setSelectedRow] = useState<number | null>(null);

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

  const tableData = useMemo(() => {
    if (!editedData.length || error || busy) {
      return [];
    }
    return editedData;
  }, [editedData, error, busy]);

  const tableColumns = useMemo<CommonTableColumn<TableConstraint>[]>(
    () =>
      COLUMNS_NAME.map((name) => ({
        key: name,
        label: name,
        render: (_value: any, row: any, index: number) => {
          const fieldValue = row[name];
          const isEmptyRow = index + 1 > editedData.length;
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
              disabled={busy}
              readOnly={isEmptyRow}
            />
          );
        },
      })),
    [busy, editedData.length, handleDataChange]
  );

  return (
    <div class="h-full w-full">
      <Table
        columns={tableColumns}
        data={tableData}
        stickyHeader
        fillViewport
        emptyMessage="No constraints data available"
        selectedRow={selectedRow}
        onSelectRow={(_row, index) => {
          setSelectedRow(index);
        }}
        onDoubleClickRow={handleDoubleClickRow}
      />
    </div>
  );
}
