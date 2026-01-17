import { useState, useMemo, useEffect, useCallback } from "preact/hooks";
import { DataAction, DataKey } from "src/stores/connection";
import type {
  ActiveTableData,
  TableStructure as TableStructureType,
  TableConstraint as TableConstraintType,
  TableWindow,
  DatabaseEngine,
} from "src/types";
import { SplitPane } from "../SplitPane";
import { TableConstraints } from "./TableConstraint";
import { TableStructure } from "./TableStructure";
import { Input } from "../common/Input";
import { TagSelect } from "../common/TagSelect";

export function TableStructurePane(props: {
  engine: DatabaseEngine;
  activeProfileScreen: string;
  activeTableData: ActiveTableData;
  activeTableWindow: TableWindow;
  tableStructure: TableStructureType[];
  tableConstraints: TableConstraintType[];
  onDataChange: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onAddNewColumn: () => void;
  onDeleteColumn: (rowIndex: number) => void;
  deletedStructureRows: Set<number>;
  onAddIndex: () => void;
  onDeleteIndex: (rowIndex: number) => void;
  deletedConstraintRows: Set<number>;
}) {
  const {
    engine,
    activeProfileScreen,
    activeTableData,
    activeTableWindow,
    tableStructure,
    tableConstraints,
    onDataChange,
    onAddNewColumn,
    onDeleteColumn,
    deletedStructureRows,
    onAddIndex,
    onDeleteIndex,
    deletedConstraintRows,
  } = props;

  // Extract primary key from constraints (find constraint where index_name contains "pkey")
  const primaryKeyConstraint = useMemo(() => {
    if (!tableConstraints || tableConstraints.length === 0) return null;
    return tableConstraints.find(
      (constraint) =>
        constraint.index_name.toLowerCase().includes("pkey") ||
        (constraint.is_unique &&
          constraint.index_name.toLowerCase().includes("primary"))
    );
  }, [tableConstraints]);

  // Extract primary key columns from the constraint
  const primaryKeyColumns = useMemo(() => {
    if (!primaryKeyConstraint) return [];
    // column_name might contain comma-separated values
    return primaryKeyConstraint.column_name
      .split(",")
      .map((col) => col.trim())
      .filter(Boolean);
  }, [primaryKeyConstraint]);

  // Get column names from table structure (exclude deleted columns)
  // Create a serialized key to track changes in column names
  const columnNamesKey = useMemo(
    () =>
      tableStructure
        .map((col, idx) => `${idx}:${col.column_name || ""}`)
        .join("|"),
    [tableStructure]
  );

  const columnNames = useMemo(() => {
    return tableStructure
      .map((col, index) => ({
        name: col.column_name?.trim() || "",
        index,
      }))
      .filter(
        (item) => item.name !== "" && !deletedStructureRows.has(item.index)
      )
      .map((item) => item.name);
  }, [columnNamesKey, tableStructure, deletedStructureRows]);

  const [tableName, setTableName] = useState(activeTableWindow.table.name);
  const [primaryKey, setPrimaryKey] = useState<string[]>(primaryKeyColumns);

  // Update state when table window changes
  useEffect(() => {
    setTableName(activeTableWindow.table.name);
  }, [activeTableWindow.table.name]);

  // Update primary key when constraints change
  useEffect(() => {
    setPrimaryKey(primaryKeyColumns);
  }, [primaryKeyColumns.join(",")]);

  // Handle table name change
  const handleTableNameChange = (value: string) => {
    setTableName(value);
    // Use rowIndex -1 to indicate table metadata change
    onDataChange("update", "structure", -1, { tableName: value });
  };

  // Toggle primary key column
  const togglePrimaryKey = useCallback(
    (columnName: string) => {
      setPrimaryKey((prev) => {
        const newKeys = prev.includes(columnName)
          ? prev.filter((key) => key !== columnName)
          : [...prev, columnName];
        // Use rowIndex -1 to indicate table metadata change
        onDataChange("update", "structure", -1, { primaryKey: newKeys });
        return newKeys;
      });
    },
    [onDataChange]
  );

  return (
    <div class="flex h-full flex-col overflow-hidden">
      {/* Table Name and Primary Key Inputs */}
      <div class="border-b border-neutral-200 bg-neutral-50 p-2">
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2">
            <label class="text-xs font-semibold text-neutral-700">Name</label>
            <Input
              value={tableName}
              onInput={(e) => handleTableNameChange(e.currentTarget.value)}
              placeholder="table_name"
              className="border border-neutral-200 bg-white text-xs"
              disabled={activeTableData.busy}
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

      {/* Structure and Constraints Split View */}
      <div class="flex-1 overflow-hidden">
        <SplitPane
          direction="vertical"
          initialRatio={0.5}
          minFirstPx={0}
          minSecondPx={0}
          splitterPx={8}
          first={
            <TableStructure
              engine={engine}
              activeProfileScreen={activeProfileScreen}
              activeTableWindowId={activeTableWindow.id}
              initData={activeTableData.structure}
              editedData={tableStructure}
              busy={activeTableData.busy}
              error={activeTableData.error}
              onDataChange={onDataChange}
              onAddNewRecord={onAddNewColumn}
              onDeleteRecord={onDeleteColumn}
              deletedRows={deletedStructureRows}
            />
          }
          second={
            <TableConstraints
              activeProfileScreen={activeProfileScreen}
              activeTableWindowId={activeTableWindow.id}
              initData={activeTableData.constraints}
              editedData={tableConstraints}
              busy={activeTableData.busy}
              error={activeTableData.error}
              onDataChange={onDataChange}
              onAddNewRecord={onAddIndex}
              onDeleteRecord={onDeleteIndex}
              deletedRows={deletedConstraintRows}
            />
          }
        />
      </div>
    </div>
  );
}
