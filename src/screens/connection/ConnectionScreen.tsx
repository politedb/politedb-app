import { useState, useMemo, useEffect, useRef } from "preact/hooks";

import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";

import { MenuBar } from "./MenuBar";
import { LeftNav } from "./LeftNav";
import { NavigationTabs } from "./NavigationTabs";
import { RightNav } from "./RightNav";
import { QueryHistory } from "./QueryHistory";
import { Box } from "src/components/common/Box";
import { cn } from "src/utils/cn";
import { ActiveWindowContent } from "./ActiveWindowContent";

import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useViewMode } from "./hooks/useViewMode";
import { useSqlHistoryRunner } from "./hooks/useSqlHistoryRunner";
import { useSchemaTablesPanel } from "./hooks/useSchemaTablesPanel";
import { useDatabaseMetadata } from "src/hooks/useDatabaseMetadata";
import { useEnsureRuntimeConnection } from "src/hooks/useEnsureRuntimeConnection";

import { SplitPane } from "src/components/SplitPane";
import { WarningRefreshDialog } from "src/components/modal/WarningRefreshDialog";
import { ErrorDialog } from "src/components/modal/ErrorDialog";
import { SaveChangesDialog } from "src/components/modal/SaveChangesDialog";
import { DatabaseSearchDialog } from "src/components/modal/DatabaseSearchDialog";

import { useConnectionActions } from "./hooks/useConnectionActions";
import { ConnectionActionsProvider } from "./ConnectionActionsContext";
import { ConnectionRuntimeProvider } from "./ConnectionRuntimeContext";
import { useConnectionShortcuts } from "./hooks/useConnectionShortcuts";
import type { TableItem } from "src/types";
import { ConnectingPanel } from "./ConnectingPanel";
import { useProfileStore } from "src/stores/profile";
import type { PatchMap } from "src/utils/generateSql";

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

export function ConnectionScreen() {
  /* =============================================================================
   * Screen store (tab-level)
   * ============================================================================= */
  const {
    activeProfileScreen,
    profileTabs,
    openWindows,
    removeTab,
    setActiveProfileScreen,
  } = useScreenStore();

  /* =============================================================================
   * Local UI state (screen-level)
   * ============================================================================= */
  const [limit, setLimit] = useState(300);
  const [offset, setOffset] = useState(0);

  const [warningRefresh, setWarningRefresh] = useState(false);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null
  );
  const [pendingTableAction, setPendingTableAction] = useState<
    "export" | "import" | "clone" | "truncate" | "drop" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);

  const { viewMode, toggleViewMode } = useViewMode(["left", "bottom"]);

  /* =============================================================================
   * Windows orchestration (depends on activeProfileScreen)
   * ============================================================================= */
  const {
    activeTab,
    windows: activeWindows,
    activeId: activeWindowId,
    activeTableWindow,
    selectWindow,
    openSqlEditor,
    openTable,
    closeWindow,
  } = useConnectionWindows(activeProfileScreen);

  const {
    connecting: connectingRuntime,
    error: errorRuntime,
    reload: reloadRuntime,
    setError: setErrorRuntime,
  } = useEnsureRuntimeConnection(activeTab);

  /* =============================================================================
   * Engine/metaKey (depends on activeTab)
   * ============================================================================= */
  const metadata = useDatabaseMetadata();
  const engine = activeTab?.engine;

  const metaKey = useMemo(() => {
    if (!activeTab?.id) return "";
    // Use tab-scoped key so tabs opened from the same profile but different
    // databases do not share stale metadata cache.
    return `${engine ?? "postgres"}:${activeTab.id}`;
  }, [engine, activeTab?.id]);

  /* =============================================================================
   * Table loading (service) + active table meta snapshot
   * ============================================================================= */
  const { loadTableData, getTableData, removeTableData } = useLoadTableData();

  const activeTableData = useMemo(() => {
    if (!activeTableWindow) return EMPTY_TABLE_META;
    return getTableData(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [
    activeProfileScreen,
    activeTableWindow?.id,
    activeTableWindow?.table?.schema,
    activeTableWindow?.table?.name,
    getTableData,
  ]);

  /* =============================================================================
   * runtimeConnectionId (derived from tab runtime conn OR table conn)
   * NOTE: this is where store + windows + tab meet
   * ============================================================================= */
  const runtimeConnectionId = useConnectionStore((s) => {
    // 1) tab-level runtime connection first
    if (activeTab?.runtimeConnectionId) return activeTab.runtimeConnectionId;

    // 2) fallback to table-level connection id
    if (!activeTableWindow) return undefined;

    const k = tableKey(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );

    return s.tableDataMap[k]?.connectionId || undefined;
  });

  /* =============================================================================
   * Schema/tables panel (depends on runtimeConnectionId + metaKey)
   * ============================================================================= */
  const {
    meta,
    activeSchema,
    onSchemaChange,
    refreshSchemaAndTables,
    tableSearchQuery,
    setTableSearchQuery,
    expandedSections,
    setExpandedSections,
    filteredTables,
    filteredFunctions,
    schemasForEditor,
    isConnecting,
  } = useSchemaTablesPanel({
    metadata,
    metaKey,
    engine,
    connectionId: runtimeConnectionId,
    defaultSchema: engine === "postgres" ? "public" : "",
  });

  const loadError = useMemo(() => {
    return (
      errorRuntime ||
      meta.error ||
      (activeTableWindow ? activeTableData.error : null)
    );
  }, [errorRuntime, meta.error, activeTableWindow, activeTableData.error]);

  /* =============================================================================
   * New table save ref (runtime)
   * ============================================================================= */
  const newTableSaveRef = useRef<(() => Promise<void>) | null>(null);

  /* =============================================================================
   * SQL history runner (depends on engine + metadata + profileId)
   * ============================================================================= */
  const { runSqlWithHistory } = useSqlHistoryRunner({
    engine,
    metadata,
    profileId: activeProfileScreen,
  });

  /* =============================================================================
   * Global actions (depends on everything above)
   * ============================================================================= */
  const actionsRaw = useConnectionActions({
    activeProfileScreen,
    activeId: activeWindowId,
    activeTab,
    profileTabs,
    openWindows,
    activeTableWindow,
    runtimeConnectionId,
    engine,

    limit,
    offset,
    setLimit,
    setOffset,

    setWarningRefresh,
    setPendingCloseTabId,
    setError,
    setShowSaveDialog,
    pendingCloseTabId,

    loadTableData,
    removeTableData,
    refreshSchemaAndTables,
    runSqlWithHistory,

    openSqlEditor,
    openTable,
    closeWindow,

    removeTab,
    setActiveProfileScreen,

    newTableSaveRef,
    refreshRuntimeConnection: reloadRuntime,
  });

  // ✅ stable provider value (avoid context rerender cascades)
  const actionsRef = useRef(actionsRaw);
  useEffect(() => {
    actionsRef.current = actionsRaw;
  }, [actionsRaw]);
  const isProfileLocked = !!activeTab?.isLocked;

  const actions = useMemo(() => {
    return {
      openSql: () => actionsRef.current.openSql(),
      refresh: () => actionsRef.current.refresh(),
      getPatchMap: () => actionsRef.current.getPatchMap(),
      getNewTableSql: () => actionsRef.current.getNewTableSql(),
      beforeSaveChanges: () => actionsRef.current.beforeSaveChanges(),
      saveChanges: () => actionsRef.current.saveChanges(),
      discardChanges: () => actionsRef.current.discardChanges(),
      closeWindow: (id: string, e: MouseEvent) =>
        actionsRef.current.closeWindow(id, e),
      closeTab: (id: string, skip?: boolean) =>
        actionsRef.current.closeTab(id, skip),
      pageChange: (l: number, o: number) => actionsRef.current.pageChange(l, o),
      selectTable: (t: TableItem) => actionsRef.current.selectTable(t),
      exportTableData: (table: TableItem) => {
        if (isProfileLocked) return;
        void actionsRef.current.selectTable(table).then(() => {
          setPendingTableAction("export");
        });
      },
      importTableData: (table: TableItem) => {
        if (isProfileLocked) return;
        void actionsRef.current.selectTable(table).then(() => {
          setPendingTableAction("import");
        });
      },
      cloneTable: (table: TableItem) => {
        if (isProfileLocked) return;
        void actionsRef.current.selectTable(table).then(() => {
          setPendingTableAction("clone");
        });
      },
      truncateTable: (table: TableItem) => {
        if (isProfileLocked) return;
        void actionsRef.current.selectTable(table).then(() => {
          setPendingTableAction("truncate");
        });
      },
      dropTable: (table: TableItem) => {
        if (isProfileLocked) return;
        void actionsRef.current.selectTable(table).then(() => {
          setPendingTableAction("drop");
        });
      },
      openSearch: () => setSearchDialogOpen(true),
    };
  }, [isProfileLocked]);

  const patchMap = useMemo(() => {
    return actions.getPatchMap() || ({} as PatchMap);
  }, [actions.getPatchMap()]);

  const newTableSql = useMemo(() => {
    return actions.getNewTableSql().data;
  }, [actions.getNewTableSql().data]);

  const { getProfileById } = useProfileStore();

  const profile = useMemo(() => {
    if (!activeTab?.profileId) return null;
    return getProfileById(activeTab.profileId);
  }, [activeTab, getProfileById]);

  /* =============================================================================
   * Keyboard shortcuts (uses stable actions)
   * ============================================================================= */
  useConnectionShortcuts({
    activeWindowId,
    activeProfileScreen,
    actions,
  });

  /* =============================================================================
   * Guards
   * ============================================================================= */
  if (!activeTab) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">No connection selected</p>
      </Box>
    );
  }

  if (isConnecting || connectingRuntime) {
    return (
      <Box className="bg-neutral-100">
        <ConnectingPanel
          label={activeTab.label}
          engine={activeTab.engine}
          viaSsh={!!profile?.input.ssh}
          tags={profile?.input?.tags}
        />
      </Box>
    );
  }

  /* =============================================================================
   * Runtime context value (stable)
   * ============================================================================= */
  const runtimeValue = useMemo(
    () => ({
      profileId: activeProfileScreen,
      engine: engine || "postgres",
      metaKey,
      metadata,
      activeSchema,
      runtimeConnectionId,
      isProfileLocked,
      limit,
      offset,
      loadError,
      runSqlWithHistory,
      refreshSchemaAndTables,
      newTableSaveRef,
      pendingTableAction,
      setPendingTableAction,
    }),
    [
      activeProfileScreen,
      engine,
      metaKey,
      metadata,
      activeSchema,
      runtimeConnectionId,
      isProfileLocked,
      limit,
      offset,
      loadError,
      runSqlWithHistory,
      refreshSchemaAndTables,
      pendingTableAction,
    ]
  );

  /* =============================================================================
   * Main content layout (no heavy hooks inside)
   * ============================================================================= */
  const contentArea = (
    <div class="transition-smooth flex flex-1 flex-col overflow-hidden">
      {activeWindows.length > 0 && (
        <NavigationTabs
          openWindows={activeWindows}
          setActiveWindowId={(id) => selectWindow(id)}
          activeWindowId={activeWindowId}
        />
      )}

      <div class={cn("flex-1 overflow-auto")}>
        <ActiveWindowContent />
      </div>
    </div>
  );

  const mainContent = viewMode.includes("bottom") ? (
    <SplitPane
      direction="vertical"
      initialRatio={0.7}
      minFirstPx={200}
      minSecondPx={150}
      splitterPx={2}
      fixedPaneOnResize="second"
      first={contentArea}
      second={
        <div class="h-full overflow-hidden border-t border-neutral-200">
          <QueryHistory activeProfileId={activeProfileScreen} />
        </div>
      }
    />
  ) : (
    contentArea
  );

  return (
    <ConnectionActionsProvider value={actions}>
      <ConnectionRuntimeProvider value={runtimeValue}>
        <div class="flex h-full flex-1 flex-col">
          <MenuBar
            activeSchema={
              activeTableWindow?.table.name
                ? activeTableWindow?.table.schema
                : activeSchema
            }
            activeTable={activeTableWindow?.table.name}
            connectionVersion={meta.version}
            viewMode={viewMode}
            loadTableError={loadError}
            onViewModeChange={toggleViewMode}
            openSQLWindow={actions.openSql}
            onRefresh={() => void actions.refresh()}
            onSearchOpen={() => setSearchDialogOpen(true)}
          />

          <div class="flex h-full flex-1 overflow-hidden">
            {viewMode.includes("left") ? (
              <SplitPane
                direction="horizontal"
                initialRatio={0.15}
                minFirstPx={200}
                minSecondPx={300}
                splitterPx={2}
                fixedPaneOnResize="first"
                first={
                  <div class="h-full overflow-hidden">
                    <LeftNav
                      engine={engine}
                      profileId={activeProfileScreen}
                      schemas={schemasForEditor}
                      currSchema={activeSchema}
                      onSchemaChange={onSchemaChange}
                      schemaLabel={engine === "mongo" ? "Database" : "Schema"}
                      tablesSectionTitle={
                        engine === "mongo" ? "Collections" : "Tables"
                      }
                      tableSearchQuery={tableSearchQuery}
                      setTableSearchQuery={setTableSearchQuery}
                      expandedSections={expandedSections}
                      setExpandedSections={setExpandedSections}
                      filteredTables={filteredTables}
                      filteredFunctions={filteredFunctions}
                      activeWindowId={activeWindowId}
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
                        fixedPaneOnResize="second"
                        first={mainContent}
                        second={
                          <div class="h-full overflow-hidden border-l border-neutral-200">
                            <RightNav sizeInfo={activeTableData.sizeInfo} />
                          </div>
                        }
                      />
                    ) : (
                      mainContent
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
                    fixedPaneOnResize="second"
                    first={mainContent}
                    second={
                      <div class="h-full overflow-hidden border-l border-neutral-200">
                        <RightNav sizeInfo={activeTableData.sizeInfo} />
                      </div>
                    }
                  />
                ) : (
                  mainContent
                )}
              </div>
            )}
          </div>

          <WarningRefreshDialog
            open={warningRefresh}
            onClose={() => {
              setWarningRefresh(false);
              setPendingCloseTabId(null);
            }}
            onDiscard={() => void actions.discardChanges()}
          />

          {error && (
            <ErrorDialog
              open={!!error}
              error={error}
              onClose={() => setError(null)}
            />
          )}

          {showSaveDialog && (
            <SaveChangesDialog
              open={showSaveDialog}
              onClose={() => setShowSaveDialog(false)}
              onConfirm={async () => {
                await actions.saveChanges();
                setShowSaveDialog(false);
              }}
              patchMap={patchMap}
              engine={engine ?? "postgres"}
              newTableSql={newTableSql}
              activeScreen={activeProfileScreen}
              getRowAt={useConnectionStore.getState().getRowAt}
              offset={offset}
            />
          )}
        </div>

        {errorRuntime && (
          <ErrorDialog
            open={!!errorRuntime}
            error={errorRuntime}
            onClose={() => setErrorRuntime(null)}
            onRetry={() => void reloadRuntime()}
          />
        )}

        <DatabaseSearchDialog
          open={searchDialogOpen}
          onClose={() => setSearchDialogOpen(false)}
          tables={meta.tables ?? []}
          schemas={meta.schemas ?? []}
          schemaLabel={engine === "mongo" ? "Database" : "Schema"}
          onSelectTable={(table) => void actions.selectTable(table)}
          onSelectSchema={onSchemaChange}
        />
      </ConnectionRuntimeProvider>
    </ConnectionActionsProvider>
  );
}
