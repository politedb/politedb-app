import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import { Box } from "src/components/common/Box";
import { Database } from "src/components/icons";
import { TableData } from "src/components/table/TableData";
import type {
  TableStructure as TableStructureType,
  TableConstraint as TableConstraintType,
  ActiveTableData,
  TableItem,
} from "src/types";

import { TableFooter } from "src/components/table/TableFooter";
import { NewTablePane } from "src/components/table/NewTablePane";
import { TableViewMode } from "src/components/table/TableViewToggle";
import { DATA_KEYS } from "src/constant";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { TableStructurePane } from "src/components/table/TableStructurePane";
import { useTableDataOperations } from "src/screens/connection/hooks/useTableDataOperations";
import { tableKey } from "src/hooks/useLoadTableData";
import { SqlWindowPane } from "./SqlWindowPane";
import { useConnectionWindows } from "./hooks/useConnectionWindows";

import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";

/* =============================================================================
 * Patches types
 * ============================================================================= */

export type RowPatch = Record<string, any>;
export type WindowPatches = Partial<
  Record<DataAction, Partial<Record<DataKey, Record<string, RowPatch>>>>
>;

const EMPTY_TABLE_DATA: ActiveTableData = {
  data: null,
  structure: null,
  constraints: null,
  sizeInfo: null,
  busy: false,
  error: null,
  connectionId: null,
};

/* =============================================================================
 * Patch helpers
 * ============================================================================= */

function extractPatchesForTableFromPatches(
  patches: WindowPatches | null
): Record<string, Record<string, any>> | null {
  if (!patches) return null;

  const result: Record<string, Record<string, any>> = {};
  const updatePatches = (patches["update"]?.["data"] ?? {}) as Record<
    string,
    any
  >;
  const createPatches = (patches["create"]?.["data"] ?? {}) as Record<
    string,
    any
  >;

  for (const [rowKey, patchData] of Object.entries(updatePatches)) {
    result[rowKey] = { ...result[rowKey], ...(patchData as any) };
  }
  for (const [rowKey, patchData] of Object.entries(createPatches)) {
    result[rowKey] = { ...result[rowKey], ...(patchData as any) };
  }

  return Object.keys(result).length ? result : null;
}

function extractNewRowKeysFromPatches(patches: WindowPatches | null): string[] {
  if (!patches) return [];
  const createPatches = (patches["create"]?.["data"] ?? {}) as Record<
    string,
    any
  >;
  return Object.keys(createPatches).filter((k) => k.startsWith("new-"));
}

function extractDeletedRowsFromPatches(
  patches: WindowPatches | null,
  dataKey: DataKey
): Set<number> {
  if (!patches) return new Set<number>();

  const deletePatches = (patches["delete"]?.[dataKey] ?? {}) as Record<
    string,
    any
  >;
  const deleted = new Set<number>();

  for (const rowKey of Object.keys(deletePatches)) {
    const idx = parseInt(rowKey, 10);
    if (!Number.isNaN(idx)) deleted.add(idx);
  }

  return deleted;
}

/* =============================================================================
 * UI states
 * ============================================================================= */

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

/* =============================================================================
 * Component (NO PROPS)
 * ============================================================================= */

export function ActiveWindowContent() {
  const actions = useConnectionActionsCtx();
  const rt = useConnectionRuntimeCtx();

  const {
    profileId,
    engine,
    metaKey,
    metadata,
    activeSchema,
    runtimeConnectionId,
    limit,
    offset,
    loadError,
    refreshSchemaAndTables,
    newTableSaveRef,
    runSqlWithHistory,
  } = rt;

  const {
    hasAnyWindow,
    activeId,
    activeWindow,
    activeSqlWindow,
    activeTableWindow,
  } = useConnectionWindows(profileId);

  const [viewMode, setViewMode] = useState<TableViewMode>("data");

  useEffect(() => {
    setViewMode("data");
  }, [activeTableWindow?.id]);

  // store setters
  const setPatchMap = useConnectionStore((s) => s.setDataPatchMap);
  const setTableStructure = useConnectionStore((s) => s.setTableStructure);
  const setTableConstraints = useConnectionStore((s) => s.setTableConstraints);

  const activeTableData = useConnectionStore((s) => {
    if (!activeTableWindow) return EMPTY_TABLE_DATA;
    const k = tableKey(
      profileId,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
    return (s.tableDataMap as any)[k] ?? EMPTY_TABLE_DATA;
  });

  const tableStructureMap = useConnectionStore((s) => s.tableStructure);
  const tableConstraintsMap = useConnectionStore((s) => s.tableConstraints);
  const dataPatchMapByScreen = useConnectionStore((s) => s.dataPatchMap);

  const tableStructure: TableStructureType[] = useMemo(() => {
    if (!activeId) return [];
    return tableStructureMap[profileId]?.[activeId] ?? [];
  }, [tableStructureMap, profileId, activeId]);

  const tableConstraints: TableConstraintType[] = useMemo(() => {
    if (!activeId) return [];
    return tableConstraintsMap[profileId]?.[activeId] ?? [];
  }, [tableConstraintsMap, profileId, activeId]);

  const windowPatches: WindowPatches | null = useMemo(() => {
    if (!activeTableWindow) return null;
    return ((dataPatchMapByScreen as any)[profileId]?.[activeTableWindow.id]
      ?.patches ?? null) as WindowPatches | null;
  }, [dataPatchMapByScreen, profileId, activeTableWindow?.id]);

  const tablePatches = useMemo(
    () => extractPatchesForTableFromPatches(windowPatches),
    [windowPatches]
  );

  const tableNewRowKeys = useMemo(
    () => extractNewRowKeysFromPatches(windowPatches),
    [windowPatches]
  );

  const deletedStructureRows = useMemo(
    () => extractDeletedRowsFromPatches(windowPatches, DATA_KEYS.structure),
    [windowPatches]
  );
  const deletedConstraintRows = useMemo(
    () => extractDeletedRowsFromPatches(windowPatches, DATA_KEYS.constraints),
    [windowPatches]
  );
  const deletedDataRows = useMemo(
    () => extractDeletedRowsFromPatches(windowPatches, DATA_KEYS.data),
    [windowPatches]
  );

  // local onDataChange -> patch store
  const onDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      if (!profileId || !activeTableWindow) return;

      let rowKey: string;
      let patchData = data;

      if (rowIndex === -1 && data.__rowKey) {
        rowKey = data.__rowKey;
        const { __rowKey, ...rest } = data;
        patchData = rest;
      } else {
        rowKey = String(rowIndex);
      }

      setPatchMap(profileId, {
        dataKey,
        action,
        tableData: activeTableData,
        tableWindow: activeTableWindow,
        rowKey,
        data: patchData,
      });
    },
    [profileId, activeTableWindow, activeTableData, setPatchMap]
  );

  // add operations
  const handleAddColumn = useCallback(() => {
    if (!activeTableWindow || !activeId) return;

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

    setTableStructure(profileId, activeId, [...tableStructure, newRecord]);
    onDataChange(
      "create",
      DATA_KEYS.structure,
      tableStructure.length,
      newRecord
    );
  }, [
    profileId,
    activeId,
    activeTableWindow?.id,
    tableStructure,
    setTableStructure,
    onDataChange,
  ]);

  const handleAddIndex = useCallback(() => {
    if (!activeTableWindow || !activeId) return;

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

    setTableConstraints(profileId, activeId, [...tableConstraints, newRecord]);
    onDataChange(
      "create",
      DATA_KEYS.constraints,
      tableConstraints.length,
      newRecord
    );
  }, [
    profileId,
    activeId,
    activeTableWindow?.id,
    tableConstraints,
    setTableConstraints,
    onDataChange,
  ]);

  const { handleAddRow: handleAddRowFromHook } = useTableDataOperations({
    onDataChange,
  });

  const handleAddRow = useCallback(() => {
    if (!activeTableWindow) return;
    if (!activeTableData.data?.columns) return;
    handleAddRowFromHook(activeTableData.data.columns, onDataChange);
  }, [
    activeTableWindow?.id,
    activeTableData.data,
    handleAddRowFromHook,
    onDataChange,
  ]);

  // delete operations
  const handleDeleteColumn = useCallback(
    (rowIndex: number) => {
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.structure, rowIndex, {});
    },
    [activeTableWindow?.id, onDataChange]
  );

  const handleDeleteIndex = useCallback(
    (rowIndex: number) => {
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.constraints, rowIndex, {});
    },
    [activeTableWindow?.id, onDataChange]
  );

  const handleDeleteRow = useCallback(
    (rowIndex: number) => {
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.data, rowIndex, {});
    },
    [activeTableWindow?.id, onDataChange]
  );

  const handleFilters = useCallback(() => {
    console.log("filters");
  }, []);

  const isShowNewTablePane = useMemo(() => {
    if (!activeTableWindow) return false;
    const noLoadedData =
      !activeTableData.data && !activeTableData.busy && !activeTableData.error;
    return !!activeTableWindow.table.new || noLoadedData;
  }, [
    activeTableWindow?.id,
    activeTableWindow?.table?.new,
    activeTableData.data,
    activeTableData.busy,
    activeTableData.error,
  ]);

  const handleTableCreated = useCallback(
    async (tableName: string) => {
      if (!activeTableWindow) return;

      await actions.closeWindow(
        activeTableWindow.id,
        new MouseEvent("click") as unknown as MouseEvent
      );

      await refreshSchemaAndTables();

      const t = { schema: activeSchema, name: tableName } as TableItem;
      await actions.selectTable(t);
    },
    [actions, activeTableWindow, refreshSchemaAndTables, activeSchema]
  );

  // Guards
  if (loadError) return <ErrorState error={loadError} />;
  if (!hasAnyWindow) return <EmptyState onNewSql={actions.openSql} />;

  if (!activeWindow) {
    return (
      <Box>
        <p class="text-neutral-500">Select a tab to continue</p>
      </Box>
    );
  }

  // ✅ SQL pane only created when needed
  if (activeSqlWindow) {
    return (
      <SqlWindowPane
        win={activeSqlWindow}
        engine={engine}
        runtimeConnectionId={runtimeConnectionId}
        metaKey={metaKey}
        metadata={metadata}
        onRunSql={runSqlWithHistory}
      />
    );
  }

  if (!activeTableWindow) return null;

  if (isShowNewTablePane) {
    return (
      <NewTablePane
        engine={engine}
        activeSchema={activeSchema}
        table={activeTableWindow.table}
        onSuccess={handleTableCreated}
        activeProfileScreen={profileId}
        tableWindowId={activeTableWindow.id}
        onSaveRef={(saveFn) => {
          newTableSaveRef.current = saveFn;
        }}
      />
    );
  }

  if (activeTableData.busy) return <LoadingTableState />;
  if (activeTableData.error)
    return <TableErrorState error={String(activeTableData.error)} />;

  return (
    <div class="flex h-full flex-col">
      <div class="flex-1 overflow-hidden">
        {viewMode === "structure" ? (
          <div class="flex h-full flex-col overflow-hidden bg-white">
            <TableStructurePane
              engine={engine}
              activeProfileScreen={profileId}
              activeTableWindow={activeTableWindow}
              activeTableData={activeTableData}
              tableStructure={tableStructure}
              tableConstraints={tableConstraints}
              onDataChange={onDataChange}
              onAddNewColumn={handleAddColumn}
              onDeleteColumn={handleDeleteColumn}
              deletedStructureRows={deletedStructureRows}
              onAddIndex={handleAddIndex}
              onDeleteIndex={handleDeleteIndex}
              deletedConstraintRows={deletedConstraintRows}
            />
          </div>
        ) : (
          <TableData
            key={activeTableWindow.id}
            columns={activeTableData.data?.columns ?? []}
            data={activeTableData.data?.rows ?? []}
            onCellChange={onDataChange}
            patches={tablePatches}
            newRowKeys={tableNewRowKeys}
            onDeleteRow={handleDeleteRow}
            deletedRows={deletedDataRows}
          />
        )}
      </div>

      <TableFooter
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        limit={limit}
        offset={offset}
        totalRows={activeTableData.data?.rowCount ?? 0}
        onPageChange={(l, o) => void actions.pageChange(l, o)}
        onAddColumn={handleAddColumn}
        onAddIndex={handleAddIndex}
        onAddRow={handleAddRow}
        onFilters={handleFilters}
      />
    </div>
  );
}
