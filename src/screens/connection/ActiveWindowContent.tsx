import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import { TableData } from "src/components/table/TableData";
import type {
  TableStructure as TableStructureType,
  TableConstraint as TableConstraintType,
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
import { EmptyWindow } from "./EmptyWindow";
import { LoadingTableState } from "./LoadingTableState";
import { ErrorState } from "./ErrorState";

/* =============================================================================
 * Patches types
 * ============================================================================= */

export type RowPatch = Record<string, any>;
export type WindowPatches = Partial<
  Record<DataAction, Partial<Record<DataKey, Record<string, RowPatch>>>>
>;

const EMPTY_TABLE_META = {
  columns: null,
  structure: null,
  constraints: null,
  sizeInfo: null,
  rowCount: null,
  busy: false,
  error: null,
  connectionId: null,
};

const EMPTY_ARRAY: any[] = [];
const EMPTY_SET = new Set<number>();

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
  if (!patches) return EMPTY_ARRAY;
  const createPatches = (patches["create"]?.["data"] ?? {}) as Record<
    string,
    any
  >;
  const keys = Object.keys(createPatches).filter((k) => k.startsWith("new-"));
  return keys.length > 0 ? keys : EMPTY_ARRAY;
}

function extractDeletedRowsFromPatches(
  patches: WindowPatches | null,
  dataKey: DataKey
): Set<number> {
  if (!patches) return EMPTY_SET;

  const deletePatches = (patches["delete"]?.[dataKey] ?? {}) as Record<
    string,
    any
  >;

  const keys = Object.keys(deletePatches);
  if (keys.length === 0) return EMPTY_SET;

  const deleted = new Set<number>();
  for (const rowKey of keys) {
    const idx = parseInt(rowKey, 10);
    if (!Number.isNaN(idx)) deleted.add(idx);
  }

  return deleted;
}

/* =============================================================================
 * Read store snapshot (NO subscription, just read once)
 * ============================================================================= */

function getTableMeta(key: string) {
  if (!key) return EMPTY_TABLE_META;
  return useConnectionStore.getState().tableDataMap[key] ?? EMPTY_TABLE_META;
}

function getTableStructure(profileId: string, tableId: string) {
  if (!tableId) return EMPTY_ARRAY;
  return (
    useConnectionStore.getState().tableStructure[profileId]?.[tableId] ??
    EMPTY_ARRAY
  );
}

function getTableConstraints(profileId: string, tableId: string) {
  if (!tableId) return EMPTY_ARRAY;
  return (
    useConnectionStore.getState().tableConstraints[profileId]?.[tableId] ??
    EMPTY_ARRAY
  );
}

function getWindowPatches(
  profileId: string,
  windowId: string | undefined
): WindowPatches | null {
  if (!windowId) return null;
  return ((useConnectionStore.getState().dataPatchMap as any)[profileId]?.[
    windowId
  ]?.patches ?? null) as WindowPatches | null;
}

/* =============================================================================
 * Component
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

  const { hasAnyWindow, activeId, activeSqlWindow, activeTableWindow } =
    useConnectionWindows(profileId);

  const [viewMode, setViewMode] = useState<TableViewMode>("data");

  // =========================================================================
  // Force update trigger (only for data that MUST trigger re-render)
  // =========================================================================
  const [, forceUpdate] = useState(0);
  const triggerRender = useCallback(() => forceUpdate((n) => n + 1), []);

  useEffect(() => {
    setViewMode("data");
  }, [activeTableWindow?.id]);

  // =========================================================================
  // Computed keys
  // =========================================================================
  const activeKey = useMemo(() => {
    if (!activeTableWindow) return "";
    return tableKey(
      profileId,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [
    profileId,
    activeTableWindow?.table?.schema,
    activeTableWindow?.table?.name,
  ]);

  // =========================================================================
  // Subscribe ONLY to critical changes that require re-render
  // =========================================================================
  useEffect(() => {
    if (!activeKey) return;

    // Initialize rows
    useConnectionStore.getState().initRows(activeKey, 5000);

    // Track what we care about
    let lastBusy = getTableMeta(activeKey).busy;
    let lastError = getTableMeta(activeKey).error;
    let lastColumnsLen = getTableMeta(activeKey).columns?.length ?? 0;
    let lastRowCount = getTableMeta(activeKey).rowCount;

    const unsub = useConnectionStore.subscribe((state) => {
      const meta = state.tableDataMap[activeKey] ?? EMPTY_TABLE_META;

      const busy = meta.busy;
      const error = meta.error;
      const columnsLen = meta.columns?.length ?? 0;
      const rowCount = meta.rowCount;

      // Only trigger re-render if critical fields changed
      const shouldUpdate =
        busy !== lastBusy ||
        error !== lastError ||
        columnsLen !== lastColumnsLen ||
        rowCount !== lastRowCount;

      if (shouldUpdate) {
        lastBusy = busy;
        lastError = error;
        lastColumnsLen = columnsLen;
        lastRowCount = rowCount;
        triggerRender();
      }
    });

    return unsub;
  }, [activeKey, triggerRender]);

  // =========================================================================
  // Read current values from store (snapshot, no subscription)
  // =========================================================================
  const activeTableMeta = getTableMeta(activeKey);
  const tableStructure = getTableStructure(profileId, activeId ?? "");
  const tableConstraints = getTableConstraints(profileId, activeId ?? "");
  const windowPatches = getWindowPatches(profileId, activeTableWindow?.id);

  // =========================================================================
  // Derived patch data (memoized)
  // =========================================================================
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

  // =========================================================================
  // Data change handler
  // =========================================================================
  const onDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      if (!profileId || !activeTableWindow) return;

      const currentMeta = getTableMeta(activeKey);

      let rowKey: string;
      let patchData = data;

      if (rowIndex === -1 && (data as any).__rowKey) {
        rowKey = String((data as any).__rowKey);
        const { __rowKey, ...rest } = data as any;
        patchData = rest;
      } else {
        rowKey = String(rowIndex);
      }

      useConnectionStore.getState().setDataPatchMap(profileId, {
        dataKey,
        action,
        tableData: currentMeta,
        tableWindow: activeTableWindow,
        rowKey,
        data: patchData,
      });
    },
    [profileId, activeTableWindow, activeKey]
  );

  // =========================================================================
  // Add operations
  // =========================================================================
  const handleAddColumn = useCallback(() => {
    if (!activeTableWindow || !activeId) return;

    const currentStructure = getTableStructure(profileId, activeId);

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

    useConnectionStore
      .getState()
      .setTableStructure(profileId, activeId, [...currentStructure, newRecord]);
    onDataChange(
      "create",
      DATA_KEYS.structure,
      currentStructure.length,
      newRecord
    );
  }, [profileId, activeId, activeTableWindow, onDataChange]);

  const handleAddIndex = useCallback(() => {
    if (!activeTableWindow || !activeId) return;

    const currentConstraints = getTableConstraints(profileId, activeId);

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

    useConnectionStore
      .getState()
      .setTableConstraints(profileId, activeId, [
        ...currentConstraints,
        newRecord,
      ]);
    onDataChange(
      "create",
      DATA_KEYS.constraints,
      currentConstraints.length,
      newRecord
    );
  }, [profileId, activeId, activeTableWindow, onDataChange]);

  const { handleAddRow: handleAddRowFromHook } = useTableDataOperations({
    onDataChange,
  });

  const handleAddRow = useCallback(() => {
    if (!activeTableWindow) return;

    const currentMeta = getTableMeta(activeKey);
    const cols = currentMeta.columns ?? [];

    if (!cols.length) return;
    handleAddRowFromHook(cols as any, onDataChange);
  }, [activeTableWindow, activeKey, handleAddRowFromHook, onDataChange]);

  // =========================================================================
  // Delete operations
  // =========================================================================
  const handleDeleteColumn = useCallback(
    (rowIndex: number) => {
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.structure, rowIndex, {});
    },
    [activeTableWindow, onDataChange]
  );

  const handleDeleteIndex = useCallback(
    (rowIndex: number) => {
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.constraints, rowIndex, {});
    },
    [activeTableWindow, onDataChange]
  );

  const handleDeleteRow = useCallback(
    (rowIndex: number) => {
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.data, rowIndex, {});
    },
    [activeTableWindow, onDataChange]
  );

  const handleFilters = useCallback(() => {
    console.log("filters");
  }, []);

  // =========================================================================
  // New table pane logic
  // =========================================================================
  const isShowNewTablePane = useMemo(() => {
    if (!activeTableWindow) return false;

    const hasCols =
      Array.isArray(activeTableMeta.columns) &&
      activeTableMeta.columns.length > 0;

    const noLoadedData =
      !hasCols && !activeTableMeta.busy && !activeTableMeta.error;

    return !!activeTableWindow.table.new || noLoadedData;
  }, [
    activeTableWindow,
    activeTableMeta.columns,
    activeTableMeta.busy,
    activeTableMeta.error,
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

  // =========================================================================
  // Page-ready state
  // =========================================================================
  const [pageReady, setPageReady] = useState(false);

  useEffect(() => {
    setPageReady(false);
    if (!activeKey) return;

    // Fast path: already has at least 1 row
    const st0 = useConnectionStore.getState();
    const n0 = Math.min(20, limit);
    for (let i = 0; i < n0; i++) {
      if (st0.getRowAt(activeKey, offset + i)) {
        setPageReady(true);
        return;
      }
    }

    let lastVersion = -1;

    const unsub = useConnectionStore.subscribe((state) => {
      const info = state.getRowsWindowInfo(activeKey);
      const version = info?.version ?? 0;

      if (version === lastVersion) return;
      lastVersion = version;

      const n = Math.min(20, limit);
      for (let i = 0; i < n; i++) {
        if (useConnectionStore.getState().getRowAt(activeKey, offset + i)) {
          setPageReady(true);
          unsub();
          return;
        }
      }
    });

    return unsub;
  }, [activeKey, offset, limit]);

  // =========================================================================
  // Loading state
  // =========================================================================
  const hasCols =
    Array.isArray(activeTableMeta.columns) &&
    activeTableMeta.columns.length > 0;

  const shouldShowFullLoading =
    !!activeTableMeta.busy &&
    !activeTableMeta.error &&
    (!hasCols || !pageReady);

  // =========================================================================
  // Early returns / Guards
  // =========================================================================
  if (loadError) return <ErrorState message={loadError} />;
  if (!hasAnyWindow) return <EmptyWindow onNewSql={actions.openSql} />;

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

  if (shouldShowFullLoading) return <LoadingTableState />;

  if (activeTableMeta.error) {
    return <ErrorState message={String(activeTableMeta.error)} />;
  }

  // =========================================================================
  // Page view mode calculations
  // =========================================================================
  const pageOffset = offset;
  const pageLimit = limit;

  const pageTotalRows = useMemo(() => {
    const MIN_ROWS = 0;

    if (typeof activeTableMeta.rowCount === "number") {
      const remaining = Math.max(0, activeTableMeta.rowCount - pageOffset);

      return Math.max(MIN_ROWS, Math.min(pageLimit, remaining));
    }

    return Math.max(MIN_ROWS, pageLimit);
  }, [activeTableMeta.rowCount, pageOffset, pageLimit]);

  const totalRowsForFooter = useMemo(() => {
    if (typeof activeTableMeta.rowCount === "number")
      return activeTableMeta.rowCount;
    return pageOffset + pageTotalRows;
  }, [activeTableMeta.rowCount, pageOffset, pageTotalRows]);

  // =========================================================================
  // Row accessor (NO subscription, just read from store)
  // =========================================================================
  const getRowAt = useCallback(
    (localIdx: number) => {
      if (!activeKey) return undefined;
      return useConnectionStore
        .getState()
        .getRowAt(activeKey, pageOffset + localIdx);
    },
    [activeKey, pageOffset]
  );

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="min-h-0 flex-1 overflow-hidden">
        {viewMode === "structure" ? (
          <div class="flex h-full flex-col overflow-hidden bg-white">
            <TableStructurePane
              engine={engine}
              profileId={profileId}
              activeTableWindow={activeTableWindow}
              activeTableMeta={activeTableMeta}
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
            columns={activeTableMeta.columns ?? []}
            totalRows={pageTotalRows}
            getRowAt={getRowAt}
            onCellChange={onDataChange}
            patches={tablePatches}
            newRowKeys={tableNewRowKeys}
            onDeleteRow={handleDeleteRow}
            onAddRow={handleAddRow}
            deletedRows={deletedDataRows}
          />
        )}
      </div>

      <TableFooter
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        limit={limit}
        offset={offset}
        totalRows={totalRowsForFooter}
        onPageChange={(l, o) => void actions.pageChange(l, o)}
        onAddColumn={handleAddColumn}
        onAddIndex={handleAddIndex}
        onAddRow={handleAddRow}
        onFilters={handleFilters}
      />
    </div>
  );
}
