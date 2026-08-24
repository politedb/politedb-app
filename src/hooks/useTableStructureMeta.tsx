import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import { DATA_KEYS } from "src/constant";
import type { DataAction, DataKey } from "src/stores/connection";
import type { TableConstraint, TableStructure } from "src/types";

interface Props {
  initialTableName: string;
  constraints: TableConstraint[];
  structure: TableStructure[];
  deletedRows: Set<number>;
  onDataChange: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
}

export function useTableMetaState(props: Props) {
  const {
    initialTableName,
    constraints,
    structure,
    deletedRows,
    onDataChange,
  } = props;

  const primaryKeyFromDB = useMemo(() => {
    if (!constraints?.length) return [];

    const isTruthy = (v: unknown) =>
      v === true || String(v ?? "").toLowerCase() === "true";

    const pk = constraints.find(
      (c) =>
        isTruthy(c.is_primary) ||
        c.index_name.toLowerCase() === "primary" ||
        c.index_name.toLowerCase().includes("pkey") ||
        (c.is_unique && c.index_name.toLowerCase().includes("primary"))
    );

    if (!pk?.column_name) return [];

    return pk.column_name
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }, [constraints]);

  const columnNames = useMemo(() => {
    return structure
      .map((col, index) => ({ name: col.column_name?.trim(), index }))
      .filter((c) => c.name && !deletedRows.has(c.index))
      .map((c) => c.name!);
  }, [structure, deletedRows]);

  const [tableName, setTableName] = useState(initialTableName);
  const [primaryKey, setPrimaryKey] = useState<string[]>(primaryKeyFromDB);

  useEffect(() => {
    setTableName(initialTableName);
  }, [initialTableName]);

  useEffect(() => {
    setPrimaryKey(primaryKeyFromDB);
  }, [primaryKeyFromDB]);

  const changeTableName = useCallback(
    (name: string) => {
      setTableName(name);
      onDataChange("update", DATA_KEYS.structure, -1, {
        tableName: name,
      });
    },
    [onDataChange]
  );

  const togglePrimaryKey = useCallback(
    (column: string) => {
      setPrimaryKey((prev) => {
        const next = prev.includes(column)
          ? prev.filter((c) => c !== column)
          : [...prev, column];

        onDataChange("update", DATA_KEYS.structure, -1, {
          primaryKey: next,
        });

        return next;
      });
    },
    [onDataChange]
  );

  return {
    tableName,
    primaryKey,
    primaryKeyFromDB,
    columnNames,
    changeTableName,
    togglePrimaryKey,
  };
}
