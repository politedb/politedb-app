import { useMemo } from "preact/hooks";
import type { DatabaseEngine, TableConstraint } from "src/types";
import {
  SchemaCanvasTable,
  type SchemaCanvasColumn,
} from "./SchemaCanvasTable";
import type { InputOption } from "src/components/common/Input";
import { DataAction, DataKey } from "src/stores/connection";
import { useTableConstraintOperations } from "src/screens/connection/hooks/useTableConstraintOperations";
import { getDbConfig } from "src/utils/dbConfig";

const COLUMNS_NAME: Record<DatabaseEngine, (keyof TableConstraint)[]> = {
  postgres: [
    "index_name",
    "index_algorithm",
    "is_unique",
    "column_name",
    "condition",
    "include",
    "comment",
  ],
  mysql: ["index_name", "index_algorithm", "is_unique", "column_name"],
  mariadb: ["index_name", "index_algorithm", "is_unique", "column_name"],
  mongo: ["index_name", "index_algorithm", "is_unique", "column_name"],
  cassandra: ["index_name", "index_algorithm", "is_unique", "column_name"],
  redis: [],
  sqlserver: ["index_name", "index_algorithm", "is_unique", "column_name"],
  sqlite: ["index_name", "index_algorithm", "is_unique", "column_name"],
  d1: ["index_name", "index_algorithm", "is_unique", "column_name"],
  turso: ["index_name", "index_algorithm", "is_unique", "column_name"],
  oracle: ["index_name", "index_algorithm", "is_unique", "column_name"],
  snowflake: ["index_name", "index_algorithm", "is_unique", "column_name"],
  duckdb: ["index_name", "index_algorithm", "is_unique", "column_name"],
  clickhouse: ["index_name", "index_algorithm", "is_unique", "column_name"],
  google_sheets: [],
};

interface Props {
  initData: TableConstraint[] | null;
  columnNames: string[];
  activeProfileScreen: string;
  activeTableWindowId: string;
  busy: boolean;
  error: string | null;
  editedData: TableConstraint[];
  readOnly?: boolean;
  onAddNewRecord: () => void;
  onDeleteRecord?: (rowIndex: number) => void;
  deletedRows?: Set<number>;
  onDataChange?: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  engine: DatabaseEngine;
  searchQuery?: string;
}

export function TableConstraints({
  initData,
  columnNames,
  activeProfileScreen,
  activeTableWindowId,
  busy,
  error,
  editedData,
  readOnly = false,
  onAddNewRecord,
  onDeleteRecord,
  deletedRows = new Set(),
  onDataChange,
  engine,
  searchQuery = "",
}: Props) {
  // Use constraint operations hook
  const { handleDataChange, handleDeleteRecord } = useTableConstraintOperations(
    {
      activeProfileScreen,
      activeTableWindowId,
      initData,
      editedData,
      isLocked: readOnly,
      onDataChange,
      onDeleteRecord,
    }
  );

  const tableData = useMemo(() => {
    if (error) return [];
    if (editedData.length > 0) return editedData;
    return initData ?? [];
  }, [editedData, initData, error]);

  const dbConfig = getDbConfig(engine);

  const columnInputOptions = useMemo(
    () =>
      ({
        index_algorithm: dbConfig.indexAlgorithms.map((type) => ({
          label: type,
          value: type,
        })),
        is_unique: [
          { label: "TRUE", value: "true" },
          { label: "FALSE", value: "false" },
        ],
        column_name: columnNames.map((name) => ({
          label: name,
          value: name,
        })),
      }) as Record<keyof TableConstraint, InputOption[]>,
    [columnNames, dbConfig.indexAlgorithms]
  );

  const tableColumns = useMemo<SchemaCanvasColumn<TableConstraint>[]>(
    () =>
      COLUMNS_NAME[engine].map((key) => ({
        key,
        options: columnInputOptions[key]?.map((option) =>
          typeof option === "string" ? { label: option, value: option } : option
        ),
      })),
    [engine, columnInputOptions]
  );

  return (
    <SchemaCanvasTable
      rows={tableData}
      columns={tableColumns}
      searchQuery={searchQuery}
      readOnly={readOnly || busy}
      deletedRows={deletedRows}
      isNewRow={(index) => !initData || index >= initData.length}
      isCellDirty={(index, name) =>
        (initData?.[index]?.[name] ?? "") !== (tableData[index]?.[name] ?? "")
      }
      onChange={handleDataChange}
      onDelete={handleDeleteRecord}
      onAdd={onAddNewRecord}
    />
  );
}
