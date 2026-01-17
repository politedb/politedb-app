import { useState, useCallback, useMemo, useEffect } from "preact/hooks";
import { Input } from "src/components/common/Input";
import { Button } from "src/components/common/Button";
import {
  Table,
  type TableColumn as CommonTableColumn,
} from "src/components/common/Table";
import { Trash, Plus } from "src/components/icons";
import type { TableItem, TableColumn, DatabaseEngine } from "src/types";
import { useCreateSchemaTable } from "src/hooks/useCreateSchemaTable";
import { DATA_TYPES } from "src/constant";
import {
  useConnectionStore,
  type ConnectionState,
} from "src/stores/connection";
import { TableViewToggle } from "./TableViewToggle";
import { TagSelect } from "src/components/common/TagSelect";

const NULLABLE_OPTIONS = [
  {
    label: "YES",
    value: "YES",
  },
  {
    label: "NO",
    value: "NO",
  },
];

const COLUMNS_NAME: (keyof TableColumn)[] = [
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
  onSuccess?: (tableName: string) => void;
  onSaveRef?: (saveFn: () => Promise<void>) => void;
}

export function NewTablePane({
  activeSchema,
  table,
  engine,
  onSuccess,
  activeProfileScreen,
  tableWindowId,
  onSaveRef,
}: Props) {
  const { createTable, busy } = useCreateSchemaTable();

  const { setNewTableData, clearNewTableData } = useConnectionStore();

  // Load saved data from store
  const savedData = useConnectionStore((s: ConnectionState) => {
    if (!activeProfileScreen || !tableWindowId) return null;
    return s.newTableData[activeProfileScreen]?.[tableWindowId] ?? null;
  });

  const [tableName, setTableName] = useState(
    savedData?.tableName || table.name || ""
  );
  // Support both string (legacy) and string[] for primaryKey
  const [primaryKey, setPrimaryKey] = useState<string[]>(() => {
    const saved = savedData?.primaryKey;
    if (Array.isArray(saved)) return saved;
    if (typeof saved === "string" && saved) return [saved];
    return ["id"];
  });
  const [columns, setColumns] = useState<TableColumn[]>(
    savedData?.columns || [
      {
        column_name: "id",
        data_type: "serial",
        is_nullable: "YES",
        column_default: "",
      },
    ]
  );

  // Store initial data immediately on mount if not already saved
  useEffect(() => {
    if (!activeProfileScreen || !tableWindowId) return;
    // Only store if there's no saved data (first time opening this window)
    const currentSavedData =
      useConnectionStore.getState().newTableData[activeProfileScreen]?.[
        tableWindowId
      ];
    if (!currentSavedData) {
      setNewTableData(activeProfileScreen, tableWindowId, {
        tableName,
        primaryKey,
        columns,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileScreen, tableWindowId]); // Only run on mount/window change

  // Save to store whenever data changes
  useEffect(() => {
    if (!activeProfileScreen || !tableWindowId) return;
    setNewTableData(activeProfileScreen, tableWindowId, {
      tableName,
      primaryKey,
      columns,
    });
  }, [
    tableName,
    primaryKey,
    columns,
    activeProfileScreen,
    tableWindowId,
    setNewTableData,
  ]);

  const columnNames = useMemo(
    () => columns.map((col) => col.column_name).filter(Boolean),
    [columns]
  );

  const togglePrimaryKey = useCallback((columnName: string) => {
    setPrimaryKey((prev) => {
      if (prev.includes(columnName)) {
        return prev.filter((key) => key !== columnName);
      } else {
        return [...prev, columnName];
      }
    });
  }, []);

  const dataTypes = useMemo(
    () =>
      DATA_TYPES[engine].map((type) => ({
        label: type,
        value: type,
      })),
    [engine]
  );

  const handleAddColumn = useCallback(() => {
    setColumns((prev) => [
      ...prev,
      {
        column_name: "",
        data_type: "text",
        is_nullable: "YES",
        column_default: "",
      },
    ]);
  }, [setColumns]);

  const handleRemoveColumn = useCallback(
    (index: number) => {
      setColumns((prev) => {
        const newColumns = prev.filter((_, i) => i !== index);
        const removedColumnName = prev[index]?.column_name;
        // If we removed a primary key column, remove it from primary key array
        if (removedColumnName && primaryKey.includes(removedColumnName)) {
          setPrimaryKey((prevKeys) => {
            const newKeys = prevKeys.filter((key) => key !== removedColumnName);
            // If no primary keys left and we have columns, set first column as primary key
            if (newKeys.length === 0 && newColumns.length > 0) {
              const firstCol = newColumns[0]?.column_name;
              return firstCol ? [firstCol] : [];
            }
            return newKeys;
          });
        }
        return newColumns;
      });
    },
    [primaryKey]
  );

  const handleColumnChange = useCallback(
    (index: number, field: keyof TableColumn, value: string) => {
      setColumns((prev) => {
        const newColumns = [...prev];
        newColumns[index] = { ...newColumns[index]!, [field]: value };
        return newColumns;
      });

      // If column name changed and it was in the primary key, update primary key
      if (field === "column_name") {
        const oldName = columns[index]?.column_name;
        if (oldName && primaryKey.includes(oldName)) {
          setPrimaryKey((prev) => {
            const newKeys = prev.map((key) => (key === oldName ? value : key));
            return newKeys.filter(Boolean);
          });
        }
      }
    },
    [columns, primaryKey]
  );

  const handleSave = useCallback(async () => {
    const finalTableName = tableName.trim();
    if (!finalTableName) return;

    // Filter out empty columns
    const validColumns = columns.filter((col) => col.column_name.trim());

    if (validColumns.length === 0) {
      return;
    }

    const payload = {
      schema: activeSchema,
      tableName: finalTableName,
      primaryKey,
      columns: validColumns,
    };

    await createTable({
      payload,
      onSuccess: () => {
        // Clear saved data after successful creation
        if (activeProfileScreen && tableWindowId) {
          clearNewTableData(activeProfileScreen, tableWindowId);
        }
        onSuccess?.(finalTableName);
      },
    });
  }, [
    tableName,
    primaryKey,
    columns,
    activeSchema,
    createTable,
    onSuccess,
    activeProfileScreen,
    tableWindowId,
    clearNewTableData,
  ]);

  // Expose save function to parent via ref
  useEffect(() => {
    if (onSaveRef) {
      onSaveRef(handleSave);
    }
  }, [handleSave, onSaveRef]);

  const tableColumns = useMemo<CommonTableColumn<TableColumn>[]>(
    () => [
      {
        key: "column_name",
        label: "column_name",
        render: (_value, row, index) => (
          <Input
            value={row.column_name}
            onInput={(e) =>
              handleColumnChange(index, COLUMNS_NAME[0], e.currentTarget.value)
            }
            placeholder="column_name"
            disabled={busy}
          />
        ),
      },
      {
        key: "data_type",
        label: "data_type",
        render: (_value, row, index) => (
          <Input
            showSelect
            options={dataTypes}
            value={row.data_type}
            onValueChange={(value) =>
              handleColumnChange(index, COLUMNS_NAME[1], value)
            }
            disabled={busy}
          />
        ),
      },
      {
        key: "is_nullable",
        label: "is_nullable",
        render: (_value, row, index) => (
          <Input
            value={row.is_nullable}
            onValueChange={(value) =>
              handleColumnChange(index, COLUMNS_NAME[2], value)
            }
            disabled={busy}
            showSelect
            options={NULLABLE_OPTIONS}
          />
        ),
      },
      {
        key: "column_default",
        label: "column_default",
        render: (_value, row, index) => (
          <Input
            value={row.column_default}
            onInput={(e) =>
              handleColumnChange(index, COLUMNS_NAME[3], e.currentTarget.value)
            }
            placeholder="NULL"
            disabled={busy}
          />
        ),
      },
      {
        key: "actions",
        label: "",
        render: (_value, _row, index) => (
          <Button
            variant="ghost"
            onClick={() => handleRemoveColumn(index)}
            className="size-8 p-0 hover:bg-transparent"
            disabled={busy || columns.length <= 1}
            title="Remove column"
          >
            <Trash className="size-4 text-neutral-500" />
          </Button>
        ),
      },
    ],
    [columns, busy, dataTypes, handleColumnChange, handleRemoveColumn]
  );

  return (
    <div class="flex h-full flex-1 flex-col bg-white">
      {/* Header */}
      <div class="border-t border-b border-neutral-200 bg-neutral-50 p-2">
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2">
            <label class="text-xs font-semibold text-neutral-700">Name</label>
            <Input
              value={tableName}
              onInput={(e) => setTableName(e.currentTarget.value)}
              placeholder="table_name"
              className="border border-neutral-200 bg-white text-xs"
              disabled={busy}
            />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-xs font-semibold text-neutral-700">
              Primary
            </label>
            <TagSelect
              values={primaryKey}
              onChange={togglePrimaryKey}
              options={columnNames}
            />
          </div>
        </div>
      </div>

      {/* Column Definition Table */}
      <div class="flex-1 overflow-auto">
        <div class="min-w-full">
          <Table
            columns={tableColumns}
            data={columns}
            rowClassName="bg-green-200!"
            stickyHeader
            emptyMessage="No columns defined"
          />
        </div>
      </div>

      {/* Footer */}
      <div class="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-[9.25px]">
        <div class="flex items-center gap-1.5">
          <TableViewToggle viewMode="structure" />

          <Button variant="shadow" className="px-2" disabled>
            <Plus className="size-3.5" />
            Index
          </Button>

          <Button variant="shadow" className="px-2" onClick={handleAddColumn}>
            <Plus className="size-3.5" />
            Column
          </Button>
        </div>
      </div>
    </div>
  );
}
