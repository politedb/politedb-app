import { useEffect } from "preact/hooks";
import {
  DataAction,
  DataKey,
  TableMetaState,
  useConnectionStore,
} from "src/stores/connection";
import type {
  TableStructure as TableStructureType,
  TableConstraint as TableConstraintType,
  TableWindow,
  DatabaseEngine,
} from "src/types";
import { SplitPane } from "src/components/SplitPane";
import { TableConstraints } from "./TableConstraint";
import { TableStructure } from "./TableStructure";
import { Input } from "src/components/common/Input";
import { TagSelect } from "src/components/common/TagSelect";
import { useTableMetaState } from "src/hooks/useTableStructureMeta";

export function TableStructurePane(props: {
  engine: DatabaseEngine;
  profileId: string;
  activeTableMeta: TableMetaState;
  activeTableWindow: TableWindow;
  tableStructure: TableStructureType[];
  tableConstraints: TableConstraintType[];
  deletedStructureRows: Set<number>;
  deletedConstraintRows: Set<number>;
  onDataChange: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;
  onAddNewColumn: () => void;
  onDeleteColumn: (rowIndex: number) => void;
  onAddIndex: () => void;
  onDeleteIndex: (rowIndex: number) => void;
}) {
  const {
    engine,
    profileId,
    activeTableMeta,
    activeTableWindow,
    tableStructure,
    tableConstraints,
    deletedStructureRows,
    deletedConstraintRows,
    onDataChange,
    onAddNewColumn,
    onDeleteColumn,
    onAddIndex,
    onDeleteIndex,
  } = props;

  const {
    tableName,
    primaryKey,
    columnNames,
    changeTableName,
    togglePrimaryKey,
  } = useTableMetaState({
    initialTableName: activeTableWindow.table.name,
    constraints: tableConstraints,
    structure: tableStructure,
    deletedRows: deletedStructureRows,
    onDataChange,
  });

  const setTableStructure = useConnectionStore((s) => s.setTableStructure);
  const setTableConstraints = useConnectionStore((s) => s.setTableConstraints);

  useEffect(() => {
    if (activeTableMeta.structure && !tableStructure?.length) {
      setTableStructure(
        profileId,
        activeTableWindow.id,
        activeTableMeta.structure
      );
    }
  }, [
    profileId,
    activeTableWindow.id,
    activeTableMeta.structure,
    JSON.stringify(tableStructure),
  ]);

  useEffect(() => {
    if (activeTableMeta.constraints && !tableConstraints?.length) {
      setTableConstraints(
        profileId,
        activeTableWindow.id,
        activeTableMeta.constraints
      );
    }
  }, [
    profileId,
    activeTableWindow.id,
    activeTableMeta.constraints,
    JSON.stringify(tableConstraints),
  ]);

  return (
    <div class="flex h-full flex-col overflow-hidden">
      {/* Table Name and Primary Key Inputs */}
      <div class="border-b border-neutral-200 bg-neutral-50 p-2">
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2">
            <label class="text-xs font-semibold text-neutral-700">Name</label>
            <Input
              value={tableName}
              onInput={(e) => changeTableName(e.currentTarget.value)}
              placeholder="table_name"
              className="border border-neutral-200 bg-white text-xs"
              disabled={activeTableMeta.busy}
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
              activeProfileScreen={profileId}
              activeTableWindowId={activeTableWindow.id}
              initData={activeTableMeta.structure}
              editedData={tableStructure}
              busy={activeTableMeta.busy}
              error={activeTableMeta.error}
              onDataChange={onDataChange}
              onAddNewRecord={onAddNewColumn}
              onDeleteRecord={onDeleteColumn}
              deletedRows={deletedStructureRows}
            />
          }
          second={
            <TableConstraints
              activeProfileScreen={profileId}
              activeTableWindowId={activeTableWindow.id}
              initData={activeTableMeta.constraints}
              editedData={tableConstraints}
              busy={activeTableMeta.busy}
              error={activeTableMeta.error}
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
