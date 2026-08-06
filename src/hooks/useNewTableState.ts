import { useState, useCallback, useMemo } from "preact/hooks";
import type { TableColumn } from "src/types";
import { NewTableDataState, useConnectionStore } from "src/stores/connection";
import { useCreateSchemaTable } from "./useCreateSchemaTable";

interface Props {
  schema: string;
  activeProfileScreen: string;
  activeWindowId: string;
  isProfileLocked?: boolean;
  initialData?: NewTableDataState | null;
  onSuccess?: (tableName: string) => void;
}
export function useNewTableState({
  schema,
  activeProfileScreen,
  activeWindowId,
  isProfileLocked = false,
  initialData,
  onSuccess,
}: Props) {
  const { createTable } = useCreateSchemaTable();
  const clearNewTableData = useConnectionStore((s) => s.clearNewTableData);

  const initTableName = useMemo(() => {
    if (initialData?.tableName) return initialData.tableName;
    return activeWindowId?.replace(`table:${schema}.`, "") ?? "";
  }, [initialData?.tableName, activeWindowId, schema]);

  const [tableName, setTableName] = useState(
    initialData?.tableName ?? initTableName
  );
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

  const togglePrimaryKey = useCallback(
    (name: string) => {
      if (isProfileLocked) return;
      setPrimaryKey((prev) =>
        prev.includes(name) ? prev.filter((k) => k !== name) : [...prev, name]
      );
    },
    [isProfileLocked]
  );

  const addColumn = useCallback(
    (_row: any, index: number) => {
      if (isProfileLocked) return;
      if (index >= columns.length) {
        setColumns((prev) => [
          ...prev,
          {
            column_name: "",
            data_type: "text",
            is_nullable: "YES",
            column_default: "",
          },
        ]);
      }
    },
    [columns.length, isProfileLocked]
  );

  const removeColumn = useCallback(
    (index: number) => {
      if (isProfileLocked) return;
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
    },
    [isProfileLocked]
  );

  const updateColumn = useCallback(
    (index: number, field: keyof TableColumn, value: string) => {
      if (isProfileLocked) return;
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
    [isProfileLocked]
  );

  const handleSave = useCallback(async () => {
    if (isProfileLocked) return;
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
    isProfileLocked,
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
