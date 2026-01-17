import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "preact/hooks";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { MenuBar } from "./MenuBar";
import { LeftNav } from "./LeftNav";
import { NavigationTabs } from "./NavigationTabs";
import { RightNav } from "./RightNav";
import { QueryHistory } from "./QueryHistory";
import { Box } from "src/components/common/Box";
import { cn } from "src/utils/cn";
import type { TableItem } from "src/types";
import { ActiveWindowContent } from "./ActiveWindowContent";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useViewMode } from "./hooks/useViewMode";
import { useSqlHistoryRunner } from "./hooks/useSqlHistoryRunner";
import { useSchemaTablesPanel } from "./hooks/useSchemaTablesPanel";
import { useDatabaseMetadata } from "src/hooks/useDatabaseMetadata";
import { useEnsureRuntimeConnection } from "src/hooks/useEnsureRuntimeConnection";
import { SplitPane } from "src/components/SplitPane";
import { generateSqlFromPatches } from "src/utils/generateSql";
import { WarningRefreshDialog } from "src/components/modal/WarningRefreshDialog";
import { ErrorDialog } from "src/components/modal/ErrorDialog";
import { normalizeSqlError } from "src/utils/queryValidate";

export function ConnectionScreen() {
  const activeProfileScreen = useScreenStore((s) => s.activeProfileScreen);

  const {
    queryHistory,
    dataPatchMap,
    tableStructure,
    tableConstraints,
    setTableStructure,
    setTableConstraints,
    clearTableStructure,
    clearTableConstraints,
    clearQueryHistory: clearHistory,
    setDataPatchMap: setPatchMap,
    clearDataPatchMap: clearPatchMap,
  } = useConnectionStore();

  const [limit, setLimit] = useState(300);
  const [offset, setOffset] = useState(0);
  const [warningRefresh, setWarningRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { viewMode, toggleViewMode } = useViewMode(["left"]);

  /* =========================
   * Windows orchestration
   * ========================= */
  const {
    activeTab,
    windows: activeWindows,
    hasAnyWindow,
    activeId,
    activeWindow,
    activeTableWindow,
    activeSqlWindow,
    selectWindow,
    openSqlEditor,
    openTable,
    closeWindow,
  } = useConnectionWindows(activeProfileScreen);

  const { connecting: connectingRuntime } =
    useEnsureRuntimeConnection(activeTab);
  // ✅ only select tab-scoped data + active table entry (avoid rerender storms)

  const engine = activeTab?.engine;

  // Stable metaKey (NOT runtimeConnectionId)
  const metaKey = useMemo(() => {
    if (!activeTab?.profileId) return "";
    return `${engine ?? "postgres"}:${activeTab.profileId}`;
  }, [engine, activeTab?.profileId]);

  const [patchMap, sqlHistory] = useMemo(() => {
    return [
      dataPatchMap[activeProfileScreen] ?? {},
      queryHistory[activeProfileScreen] ?? [],
    ];
  }, [dataPatchMap, activeProfileScreen]);

  const [tableStructureData, tableConstraintsData] = useMemo(() => {
    if (!activeId) return [[], []];

    return [
      tableStructure[activeProfileScreen]?.[activeId] ?? [],
      tableConstraints[activeProfileScreen]?.[activeId] ?? [],
    ];
  }, [tableStructure, tableConstraints, activeProfileScreen, activeId]);

  const { loadTableData, getTableData } = useLoadTableData();

  /* =========================
   * Active table data
   * ========================= */
  const activeTableData = useMemo(() => {
    if (!activeTableWindow) {
      return {
        data: null,
        structure: null,
        constraints: null,
        sizeInfo: null,
        busy: false,
        error: null,
        connectionId: null,
      };
    }
    return getTableData(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [activeProfileScreen, activeTableWindow, getTableData]);

  // runtime connection fallback (table window may have its own runtime conn)
  const activeTableMapEntry = useConnectionStore((s) => {
    if (!activeTableWindow) return null;
    const k = tableKey(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
    return s.tableDataMap[k] ?? null;
  });

  const runtimeConnectionId = useMemo(() => {
    if (activeTab?.runtimeConnectionId) return activeTab.runtimeConnectionId;
    return activeTableMapEntry?.connectionId || undefined;
  }, [activeTab?.runtimeConnectionId, activeTableMapEntry?.connectionId]);

  /* =========================
   * Metadata (single instance) + Left panel
   * ========================= */
  const metadata = useDatabaseMetadata();

  const {
    meta, // includes loading/progress/error
    activeSchema,
    onSchemaChange,
    refreshSchemaAndTables,

    tableSearchQuery,
    setTableSearchQuery,

    expandedSections,
    setExpandedSections,

    filteredTables,

    // ✅ for editor completion (full metadata)
    schemasForEditor,

    isConnecting,
  } = useSchemaTablesPanel({
    metadata, // ✅ IMPORTANT: use the same instance
    metaKey,
    engine,
    connectionId: runtimeConnectionId,
    defaultSchema: "public",
  });

  const loadError = useMemo(() => {
    return meta.error || (activeTableWindow ? activeTableData.error : null);
  }, [meta.error, activeTableWindow, activeTableData.error]);

  // check if there are any patches to apply
  const hasPatches = useMemo(
    () => Object.keys(patchMap).some((windowId) => patchMap[windowId]),
    [patchMap]
  );

  // check if we have new table data to save (reactive to store changes)
  const newTableData = useConnectionStore((s) => {
    if (!activeTableWindow || !activeId) return null;
    return s.newTableData[activeProfileScreen]?.[activeId] ?? null;
  });

  const hasNewTableData = useMemo(() => {
    if (!newTableData) return false;
    // Check if we have valid data (table name and at least one column)
    return (
      newTableData.tableName.trim().length > 0 &&
      newTableData.columns.some((col) => col.column_name.trim())
    );
  }, [newTableData]);

  // Ref to store the save function from NewTablePane
  const newTableSaveRef = useRef<(() => Promise<void>) | null>(null);

  /* =========================
   * SQL execution + history + DDL invalidate
   * ========================= */
  const { runSqlWithHistory } = useSqlHistoryRunner({
    engine,
    metadata, // ✅ same instance (DDL invalidation will affect panel/editor)
    profileId: activeProfileScreen,
  });

  const handlePageChange = useCallback(
    (limit: number, offset: number) => {
      setLimit(limit);
      setOffset(offset);

      if (!activeTableWindow) return;

      loadTableData(
        activeTableWindow.table.schema,
        activeTableWindow.table.name,
        { limit, offset }
      );
    },
    [activeTableWindow, loadTableData, setLimit, setOffset]
  );

  /* =========================
   * Actions
   * ========================= */
  const handleOpenSqlEditor = useCallback(() => {
    openSqlEditor();
  }, [openSqlEditor]);

  const handleSelectTable = useCallback(
    async (table: TableItem) => {
      await openTable(table);
    },
    [openTable]
  );

  const handleClearChanges = useCallback(
    (profileScreen: string, tableWindowId?: string) => {
      clearTableConstraints(profileScreen, tableWindowId);
      clearTableStructure(profileScreen, tableWindowId);
      clearPatchMap(profileScreen, tableWindowId);
    },
    [clearTableConstraints, clearTableStructure, clearPatchMap]
  );

  const handleCloseWindow = useCallback(
    async (windowId: string, e: MouseEvent) => {
      await closeWindow(windowId, e);
      handleClearChanges(activeProfileScreen, windowId);
    },
    [activeProfileScreen, closeWindow, handleClearChanges]
  );

  const handleDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      if (!activeProfileScreen || !activeTableWindow) {
        return;
      }

      // For new rows (rowIndex === -1), extract the unique rowKey from data
      // Otherwise, use the rowIndex as the rowKey
      let rowKey: string;
      let patchData = data;

      if (rowIndex === -1 && data.__rowKey) {
        rowKey = data.__rowKey;
        // Remove __rowKey from the actual patch data
        const { __rowKey, ...rest } = data;
        patchData = rest;
      } else {
        rowKey = String(rowIndex);
      }

      setPatchMap(activeProfileScreen, {
        dataKey,
        action,
        tableData: activeTableData,
        tableWindow: activeTableWindow,
        rowKey,
        data: patchData,
      });
    },
    [
      activeProfileScreen,
      JSON.stringify(activeTableWindow),
      JSON.stringify(activeTableData),
      setPatchMap,
    ]
  );

  const handleRefresh = useCallback(async () => {
    if (hasPatches) {
      setWarningRefresh(true);
      return;
    }

    // refresh metadata (schemas/tables/columns) without changing UI state
    await refreshSchemaAndTables();

    // refresh active table data (rows)
    if (!activeTableWindow) return;

    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset }
    );
  }, [refreshSchemaAndTables, activeTableWindow, loadTableData, limit, offset]);

  const handleSaveNewTable = useCallback(async () => {
    if (newTableSaveRef.current) {
      await newTableSaveRef.current();
    }
  }, []);

  const handleApplyPatches = useCallback(async () => {
    if (!activeTableWindow || !runtimeConnectionId) return;

    try {
      // Generate SQL from patches
      const sql = generateSqlFromPatches(patchMap, engine || "postgres");

      if (!sql.trim()) {
        // Clear patches after successful execution
        setError("An error occurred while applying patches.");
        return;
      }

      // Execute the SQL
      await runSqlWithHistory({
        connectionId: runtimeConnectionId,
        sql,
      });

      // Clear patches after successful execution
      handleClearChanges(activeProfileScreen, activeTableWindow.id);

      // Refresh table data
      await loadTableData(
        activeTableWindow.table.schema,
        activeTableWindow.table.name,
        { limit, offset }
      );
    } catch (error) {
      const msg = normalizeSqlError(error);
      setError(msg);
    }
  }, [
    limit,
    offset,
    activeProfileScreen,
    activeTableWindow,
    runtimeConnectionId,
    hasPatches,
    patchMap,
    engine,
    runSqlWithHistory,
    loadTableData,
    handleClearChanges,
  ]);

  const handleSaveChanges = useCallback(async () => {
    if (!activeTableWindow || !runtimeConnectionId) return;

    const promises = [];
    if (hasPatches) {
      promises.push(handleApplyPatches());
    }
    if (hasNewTableData) {
      promises.push(handleSaveNewTable());
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }, [
    activeTableWindow,
    runtimeConnectionId,
    handleApplyPatches,
    handleSaveNewTable,
    hasPatches,
    hasNewTableData,
  ]);

  const handleTableCreated = useCallback(
    async (tableName: string) => {
      await closeWindow(activeTableWindow!.id);

      // Refresh metadata to include the new table
      await refreshSchemaAndTables();

      // Open the newly created table
      await openTable({
        schema: activeSchema,
        name: tableName,
      });
    },
    [
      activeTableWindow,
      activeSchema,
      refreshSchemaAndTables,
      openTable,
      closeWindow,
    ]
  );

  useEffect(() => {
    if (activeTableData.structure && activeId && !tableStructureData?.length) {
      setTableStructure(
        activeProfileScreen,
        activeId,
        activeTableData.structure
      );
    }
  }, [activeTableData.structure, tableStructure, activeId, activeTableWindow]);

  useEffect(() => {
    if (
      activeTableData.constraints &&
      activeId &&
      !tableConstraintsData?.length
    ) {
      setTableConstraints(
        activeProfileScreen,
        activeId,
        activeTableData.constraints
      );
    }
  }, [
    activeTableData.constraints,
    tableConstraints,
    activeId,
    activeTableWindow,
  ]);

  /* =========================
   * Guards
   * ========================= */
  if (!activeTab) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">No connection selected</p>
      </Box>
    );
  }

  if (isConnecting || connectingRuntime) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">Connecting to {activeTab.label}...</p>
      </Box>
    );
  }

  /* =========================
   * Render helpers
   * ========================= */
  const renderMainContent = useCallback(() => {
    const contentArea = (
      <div class="transition-smooth flex flex-1 flex-col overflow-hidden">
        {activeWindows.length > 0 && (
          <div
            class={cn(
              "flex shrink-0 items-end overflow-x-auto overflow-y-hidden pt-1"
            )}
          >
            <NavigationTabs
              openWindows={activeWindows}
              setActiveWindowId={(id) => selectWindow(id)}
              activeWindowId={activeId}
              handleCloseWindow={handleCloseWindow}
            />
          </div>
        )}

        <div
          class={cn(
            "flex-1 overflow-auto",
            viewMode.includes("left") && "animate-slide-in-right",
            viewMode.includes("right") && "animate-slide-in-left",
            viewMode.includes("bottom") && "animate-slide-in-up"
          )}
        >
          <ActiveWindowContent
            activeProfileScreen={activeProfileScreen}
            activeWindow={activeWindow}
            activeSchema={activeSchema}
            engine={engine || "postgres"}
            activeSqlWindow={activeSqlWindow}
            activeTableWindow={activeTableWindow}
            activeTableData={activeTableData}
            tableStructure={tableStructureData}
            tableConstraints={tableConstraintsData}
            setTableStructure={setTableStructure}
            setTableConstraints={setTableConstraints}
            limit={limit}
            offset={offset}
            totalRows={activeTableData.data?.rowCount ?? 0}
            loadError={loadError}
            hasAnyWindow={hasAnyWindow}
            onNewSql={handleOpenSqlEditor}
            onDataChange={handleDataChange}
            runtimeConnectionId={runtimeConnectionId}
            onRunSql={runSqlWithHistory}
            patchMap={patchMap}
            metadata={metadata}
            metaKey={metaKey}
            onPageChange={handlePageChange}
            onTableCreated={handleTableCreated}
            newTableSaveRef={newTableSaveRef}
          />
        </div>
      </div>
    );

    if (viewMode.includes("bottom")) {
      return (
        <SplitPane
          direction="vertical"
          initialRatio={0.7}
          minFirstPx={200}
          minSecondPx={150}
          splitterPx={2}
          first={contentArea}
          second={
            <div class="h-full overflow-hidden border-t border-neutral-200">
              <QueryHistory
                queries={sqlHistory}
                onClear={() => clearHistory(activeProfileScreen)}
              />
            </div>
          }
        />
      );
    }

    return contentArea;
  }, [
    activeWindows,
    activeWindow,
    activeSqlWindow,
    activeTableWindow,
    activeTableData,
    limit,
    offset,
    viewMode,
    selectWindow,
    activeId,
    handleCloseWindow,
    handleOpenSqlEditor,
    runtimeConnectionId,
    runSqlWithHistory,
    metadata,
    metaKey,
    handlePageChange,
    loadError,
    hasAnyWindow,
    engine,
    newTableSaveRef,
    activeProfileScreen,
    tableStructureData,
    tableConstraintsData,
    setTableStructure,
    setTableConstraints,
    handleDataChange,
    handleTableCreated,
  ]);

  /* =========================
   * UI
   * ========================= */
  return (
    <div class="flex h-full flex-1 flex-col">
      <MenuBar
        activeSchema={activeTableWindow?.table.schema}
        activeTable={activeTableWindow?.table.name}
        viewMode={viewMode}
        loadTableError={loadError}
        onViewModeChange={toggleViewMode}
        openSQLWindow={handleOpenSqlEditor}
        onRefresh={handleRefresh}
        canSaveChanges={hasPatches || hasNewTableData}
        handleSaveChanges={handleSaveChanges}
      />

      <div class="flex h-full flex-1 overflow-hidden">
        {viewMode.includes("left") ? (
          <SplitPane
            direction="horizontal"
            initialRatio={0.15}
            minFirstPx={200}
            minSecondPx={300}
            splitterPx={2}
            first={
              <div class="h-full overflow-hidden">
                <LeftNav
                  schemas={schemasForEditor}
                  handleOpenNewTable={openTable}
                  currSchema={activeSchema}
                  onSchemaChange={onSchemaChange}
                  tableSearchQuery={tableSearchQuery}
                  setTableSearchQuery={setTableSearchQuery}
                  expandedSections={expandedSections}
                  setExpandedSections={setExpandedSections}
                  filteredTables={filteredTables}
                  handleSelectTable={handleSelectTable}
                  activeWindowId={activeId}
                />
              </div>
            }
            second={
              <div class="flex h-full flex-1 flex-col overflow-hidden bg-neutral-100">
                {viewMode.includes("right") ? (
                  <SplitPane
                    direction="horizontal"
                    initialRatio={0.75}
                    minFirstPx={300}
                    minSecondPx={200}
                    splitterPx={2}
                    first={renderMainContent()}
                    second={
                      <div class="h-full overflow-hidden border-l border-neutral-200">
                        <RightNav sizeInfo={activeTableData.sizeInfo} />
                      </div>
                    }
                  />
                ) : (
                  renderMainContent()
                )}
              </div>
            }
          />
        ) : (
          <div class="flex h-full flex-1 overflow-hidden bg-neutral-100">
            {viewMode.includes("right") ? (
              <SplitPane
                direction="horizontal"
                initialRatio={0.75}
                minFirstPx={300}
                minSecondPx={200}
                splitterPx={2}
                first={renderMainContent()}
                second={
                  <div class="h-full overflow-hidden border-l border-neutral-200">
                    <RightNav sizeInfo={activeTableData.sizeInfo} />
                  </div>
                }
              />
            ) : (
              renderMainContent()
            )}
          </div>
        )}
      </div>

      <WarningRefreshDialog
        open={warningRefresh}
        onClose={() => setWarningRefresh(false)}
        onDiscard={() => {
          handleClearChanges(activeProfileScreen);
          setWarningRefresh(false);
        }}
      />

      {error && (
        <ErrorDialog
          open={!!error}
          error={error}
          onClose={() => setError(null)}
        />
      )}
    </div>
  );
}
