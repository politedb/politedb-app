import { useState, useCallback, useMemo } from "preact/hooks";
import type { TableColumn } from "src/types";
import { NewTableDataState, useConnectionStore } from "src/stores/connection";
import { useCreateSchemaTable } from "./useCreateSchemaTable";

interface Props {
  schema: string;
  activeProfileScreen: string;
  activeWindowId: string;
  initialData?: NewTableDataState | null;
  onSuccess?: (tableName: string) => void;
}
export function useNewTableState({
  schema,
  activeProfileScreen,
  activeWindowId,
  initialData,
  onSuccess,
}: Props) {
  const { createTable } = useCreateSchemaTable();
  const clearNewTableData = useConnectionStore((s) => s.clearNewTableData);

  const [tableName, setTableName] = useState(initialData?.tableName ?? "");
  const [columns, setColumns] = useState<TableColumn[]>(
    initialData?.columns ?? [
      {
        column_name: "id",
        data_type: "serial",
        is_nullable: "YES",
        column_default: "",
      },
    ]
  );

  const [primaryKey, setPrimaryKey] = useState<string[]>(() => {
    const pk = initialData?.primaryKey;
    if (Array.isArray(pk)) return pk;
    if (typeof pk === "string" && pk) return [pk];
    return ["id"];
  });

  const columnNames = useMemo(
    () => columns.map((c) => c.column_name).filter(Boolean),
    [columns]
  );

  const togglePrimaryKey = useCallback((name: string) => {
    setPrimaryKey((prev) =>
      prev.includes(name) ? prev.filter((k) => k !== name) : [...prev, name]
    );
  }, []);

  const addColumn = useCallback(() => {
    setColumns((prev) => [
      ...prev,
      {
        column_name: "",
        data_type: "text",
        is_nullable: "YES",
        column_default: "",
      },
    ]);
  }, []);

  const removeColumn = useCallback((index: number) => {
    setColumns((prev) => {
      const removed = prev[index]?.column_name;
      const next = prev.filter((_, i) => i !== index);

      if (removed) {
        setPrimaryKey((pk) => {
          const nextPk = pk.filter((k) => k !== removed);
          return nextPk.length === 0 && next[0]?.column_name
            ? [next[0].column_name]
            : nextPk;
        });
      }

      return next;
    });
  }, []);

  const updateColumn = useCallback(
    (index: number, field: keyof TableColumn, value: string) => {
      setColumns((prev) => {
        const next = [...prev];
        const oldName = next[index]?.column_name;

        next[index] = { ...next[index]!, [field]: value };

        if (field === "column_name" && oldName) {
          setPrimaryKey((pk) =>
            pk.map((k) => (k === oldName ? value : k)).filter(Boolean)
          );
        }

        return next;
      });
    },
    []
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
      schema,
      tableName: finalTableName,
      primaryKey: primaryKey,
      columns: validColumns,
    };

    await createTable({
      payload,
      onSuccess: () => {
        // Clear saved data after successful creation
        if (activeProfileScreen && activeWindowId) {
          clearNewTableData(activeProfileScreen, activeWindowId);
        }
        onSuccess?.(finalTableName);
      },
    });
  }, [
    tableName,
    primaryKey,
    columns,
    schema,
    activeProfileScreen,
    activeWindowId,
    onSuccess,
    createTable,
    clearNewTableData,
  ]);

  return {
    tableName,
    setTableName,
    columns,
    primaryKey,
    columnNames,
    setPrimaryKey,
    togglePrimaryKey,
    addColumn,
    removeColumn,
    updateColumn,
    handleSave,
  };
}
