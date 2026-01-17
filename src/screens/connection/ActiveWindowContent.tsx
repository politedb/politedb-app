import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { Box } from "src/components/common/Box";
import { Database } from "src/components/icons";
import { TableData } from "src/components/table/TableData";
import type {
  DatabaseEngine,
  OpenWindow,
  SqlEditorWindow,
  TableStructure as TableStructureType,
  TableConstraint as TableConstraintType,
  TableWindow,
  ActiveTableData,
} from "src/types";
import { SqlEditorPane } from "src/components/editor/SqlEditorPane";
import { SplitPane } from "src/components/SplitPane";
import type { QueryResult } from "src/lib/tauri";
import { SqlResultsPane } from "src/components/editor/SqlResultsPane";
import { useSqlRunner } from "src/screens/connection/hooks/useSqlRunner";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { TableFooter } from "src/components/table/TableFooter";
import { NewTablePane } from "src/components/table/NewTablePane";
import { TableViewMode } from "src/components/table/TableViewToggle";
import { TableStructure } from "src/components/table/TableStructure";
import { TableConstraints } from "src/components/table/TableConstraint";
import { DATA_KEYS } from "src/constant";
import { PatchMap } from "src/utils/generateSql";
import { DataAction, DataKey } from "src/stores/connection";

function EmptyState(props: { onNewSql: () => void }) {
  return (
    <Box className="text-center">
      <Database className="mx-auto mb-4 size-12 text-neutral-300" />
      <p class="text-neutral-500">
        Select a table from the sidebar (or open SQL editor) to view data
      </p>
      <div class="mt-3">
        <button
          class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white"
          onClick={props.onNewSql}
        >
          New SQL Editor
        </button>
      </div>
    </Box>
  );
}

function ErrorState(props: { error: string }) {
  return (
    <Box className="text-center">
      <p class="text-sm text-red-500">{props.error}</p>
    </Box>
  );
}

function LoadingTableState() {
  return (
    <Box className="text-center">
      <div class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
      <p class="text-neutral-500">Loading table data...</p>
    </Box>
  );
}

function TableErrorState(props: { error: string }) {
  return (
    <Box className="text-center">
      <p class="mb-2 text-red-600">Error loading table data</p>
      <p class="text-sm text-neutral-500">{props.error}</p>
    </Box>
  );
}

export function ActiveWindowContent(props: {
  activeProfileScreen: string;
  activeSchema: string;
  limit: number;
  offset: number;
  totalRows: number;
  activeWindow?: OpenWindow;
  activeSqlWindow?: SqlEditorWindow;
  activeTableWindow?: TableWindow;
  activeTableData: ActiveTableData;

  loadError: string | null;
  hasAnyWindow: boolean;

  runtimeConnectionId: string | undefined;

  onNewSql: () => void;

  onRunSql: (args: {
    windowId: string;
    connectionId: string;
    sql: string;
  }) => Promise<QueryResult>;

  onTableCreated?: (tableName: string) => void;

  onPageChange: (limit: number, offset: number) => void;

  onDataChange: (
    action: DataAction,
    dataKey: DataKey,
    rowIndex: number,
    data: Record<string, any>
  ) => void;

  patchMap: PatchMap;
  tableStructure: TableStructureType[];
  tableConstraints: TableConstraintType[];

  setTableStructure: (
    screenId: string,
    tableWindowId: string,
    structure: TableStructureType[]
  ) => void;

  setTableConstraints: (
    screenId: string,
    tableWindowId: string,
    constraints: TableConstraintType[]
  ) => void;

  engine: DatabaseEngine;

  metadata: MetadataApi;
  metaKey: string;

  newTableSaveRef?: { current: (() => Promise<void>) | null };
}) {
  const {
    activeProfileScreen,
    activeWindow,
    activeSqlWindow,
    activeTableWindow,
    activeTableData,
    activeSchema,
    limit,
    offset,
    totalRows,
    loadError,
    hasAnyWindow,
    runtimeConnectionId,
    onNewSql,
    onRunSql,
    onDataChange,
    patchMap,
    tableStructure,
    tableConstraints,
    setTableStructure,
    setTableConstraints,
    engine,
    metadata,
    metaKey,
    onPageChange,
    onTableCreated,
    newTableSaveRef,
  } = props;

  const [viewMode, setViewMode] = useState<TableViewMode>("data");

  // Reset view mode to "data" when switching tables
  useEffect(() => {
    setViewMode("data");
  }, [activeTableWindow?.id]);

  /* =========================
   * SQL runner hook
   * ========================= */
  const { sqlSlots, activeResultIndex, setActiveResultIndex, startRun } =
    useSqlRunner({
      activeSqlWindowId: activeSqlWindow?.id,
      runtimeConnectionId,
      onRunSql,
    });

  /* =========================
   * Database Meta for autocomplete (from injected cache)
   * ========================= */
  const meta = metadata.get({
    metaKey,
    engine,
    connectionId: runtimeConnectionId,
    lazy: true,
  });

  /* =========================
   * Handle add column/index/row
   * ========================= */

  const handleAddColumn = useCallback(() => {
    const newRecord: TableStructureType = {
      column_name: "",
      data_type: "",
      is_nullable: false,
      check: "",
      column_default: "",
      foreign_key: "",
      comment: "",
      isNew: true,
    };

    setTableStructure(activeProfileScreen, activeTableWindow!.id, [
      ...tableStructure,
      newRecord,
    ]);

    onDataChange?.(
      "create",
      DATA_KEYS.structure,
      tableStructure.length,
      newRecord
    );
  }, [
    activeProfileScreen,
    activeTableWindow?.id,
    tableStructure,
    setTableStructure,
    onDataChange,
  ]);

  const handleAddIndex = useCallback(() => {
    const newRecord: TableConstraintType = {
      index_name: "",
      index_algorithm: "",
      is_unique: false,
      column_name: "",
      condition: "",
      include: "",
      comment: "",
      isNew: true,
    };

    setTableConstraints(activeProfileScreen, activeTableWindow!.id, [
      ...tableConstraints,
      newRecord,
    ]);

    onDataChange?.(
      "create",
      DATA_KEYS.constraints,
      tableConstraints.length,
      newRecord
    );
  }, [
    activeProfileScreen,
    activeTableWindow?.id,
    tableConstraints,
    setTableConstraints,
    onDataChange,
  ]);

  const handleAddRow = useCallback(() => {
    console.log("add row");
  }, []);

  const handleFilters = useCallback(() => {
    console.log("filters");
  }, []);

  /* =========================
   * Global guards
   * ========================= */
  if (loadError) return <ErrorState error={loadError} />;
  if (!hasAnyWindow) return <EmptyState onNewSql={onNewSql} />;

  if (!activeWindow) {
    return (
      <Box>
        <p class="text-neutral-500">Select a tab to continue</p>
      </Box>
    );
  }

  /* =========================
   * SQL editor window
   * ========================= */
  if (activeSqlWindow) {
    return (
      <div class="h-full min-h-0 overflow-hidden">
        <SplitPane
          direction="vertical"
          initialRatio={0.45}
          minFirstPx={180}
          minSecondPx={160}
          splitterPx={8}
          first={
            <div class="h-full min-h-0">
              <SqlEditorPane
                win={activeSqlWindow}
                schemas={meta.schemas}
                tables={meta.tables}
                columnsByTable={meta.columnsByTable}
                engine={engine}
                onRunSql={({ windowId, sql }) =>
                  void startRun({ windowId, sql })
                }
              />

              {!runtimeConnectionId ? (
                <div class="border-t border-neutral-200 bg-white px-3 py-2">
                  <p class="text-xs text-neutral-500">
                    Connect to a profile to run SQL.
                  </p>
                </div>
              ) : null}
            </div>
          }
          second={
            <SqlResultsPane
              windowId={activeSqlWindow.id}
              slots={sqlSlots}
              activeIndex={activeResultIndex}
              setActiveIndex={setActiveResultIndex}
            />
          }
        />
      </div>
    );
  }

  /* =========================
   * Table window
   * ========================= */
  if (!activeTableWindow) return null;

  // Check if this is a new table (starts with "new_table" or has no data/structure)
  const isShowNewTablePane = useMemo(() => {
    return (
      activeTableWindow?.table.new ||
      (!activeTableData.data && !activeTableData.busy && !activeTableData.error)
    );
  }, [activeTableWindow, activeTableData]);

  // Show NewTablePane for new tables
  if (isShowNewTablePane) {
    return (
      <NewTablePane
        engine={engine}
        activeSchema={activeSchema}
        table={activeTableWindow.table}
        onSuccess={onTableCreated}
        activeProfileScreen={activeProfileScreen}
        tableWindowId={activeTableWindow.id}
        onSaveRef={(saveFn) => {
          if (newTableSaveRef) {
            newTableSaveRef.current = saveFn;
          }
        }}
      />
    );
  }

  if (activeTableData.busy) return <LoadingTableState />;

  if (activeTableData.error) {
    return <TableErrorState error={String(activeTableData.error)} />;
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex-1 overflow-hidden">
        {viewMode === "structure" ? (
          <div class="flex h-full flex-col overflow-hidden bg-white">
            <div class="flex-1 overflow-auto">
              <SplitPane
                direction="vertical"
                initialRatio={0.5}
                minFirstPx={0}
                minSecondPx={0}
                splitterPx={8}
                first={
                  <TableStructure
                    activeProfileScreen={activeProfileScreen}
                    activeTableWindowId={activeTableWindow.id}
                    initData={activeTableData.structure}
                    editedData={tableStructure}
                    busy={activeTableData.busy}
                    error={activeTableData.error}
                    onDataChange={onDataChange}
                    onAddNewRecord={handleAddColumn}
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
                    onAddNewRecord={handleAddIndex}
                  />
                }
              />
            </div>
          </div>
        ) : (
          <TableData
            key={activeTableWindow.id}
            columns={activeTableData.data?.columns ?? []}
            data={activeTableData.data?.rows ?? []}
            onCellChange={onDataChange}
            patches={patchMap}
          />
        )}
      </div>

      <TableFooter
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        limit={limit}
        offset={offset}
        totalRows={totalRows}
        onPageChange={onPageChange}
        onAddColumn={handleAddColumn}
        onAddIndex={handleAddIndex}
        onAddRow={handleAddRow}
        onFilters={handleFilters}
      />
    </div>
  );
}
