import { useMemo } from "preact/hooks";
import type { DatabaseEngine, TableConstraint } from "src/types";
import {
  SchemaCanvasTable,
  type SchemaCanvasColumn,
} from "./SchemaCanvasTable";
import type { InputOption } from "src/components/common/Input";
import { DataAction, DataKey } from "src/stores/connection";
import { useTableConstraintOperations } from "src/screens/connection/hooks/useTableConstraintOperations";
import { getDbConfig } from "src/lib/engines/dbConfig";
import { INDEX_COLUMN_LABELS, INDEX_COLUMN_WIDTHS } from "./schemaColumnLabels";
import { canvasOptions, schemaEditorRows } from "./schemaEditorRows";

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

  const tableData = useMemo(
    () => schemaEditorRows(editedData, initData, error),
    [editedData, initData, error]
  );

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

  const multiColumnSafe = columnNames.every(
    (name) => !name.includes(",") && name === name.trim()
  );

  const tableColumns = useMemo<SchemaCanvasColumn<TableConstraint>[]>(
    () =>
      COLUMNS_NAME[engine].map((key) => ({
        key,
        label: INDEX_COLUMN_LABELS[key],
        width: INDEX_COLUMN_WIDTHS[key],
        // Several columns are stored comma-separated, which a name with a
        // comma or surrounding spaces cannot survive: pick one then.
        multiple: key === "column_name" && multiColumnSafe,
        options: canvasOptions(columnInputOptions[key]),
      })),
    [engine, columnInputOptions, multiColumnSafe]
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
      emptyMessage={
        busy && !tableData.length
          ? "Loading indexes…"
          : searchQuery.trim()
            ? "No indexes match the search."
            : readOnly
              ? "No indexes."
              : "No indexes. Add one with + Index."
      }
    />
  );
}
