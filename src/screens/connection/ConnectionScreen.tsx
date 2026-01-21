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

import { useConnectionActions } from "./hooks/useConnectionActions";
import { ConnectionActionsProvider } from "./ConnectionActionsContext";
import { ConnectionRuntimeProvider } from "./ConnectionRuntimeContext";
import { useConnectionShortcuts } from "./hooks/useConnectionShortcuts";
import type { TableItem } from "src/types";
import { ConnectingPanel } from "./ConnectingPanel";
import { useProfileStore } from "src/stores/profile";

const EMPTY_TABLE_DATA = {
  data: null,
  structure: null,
  constraints: null,
  sizeInfo: null,
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
    removeTab,
    setActiveProfileScreen,
    openWindows,
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
  const [error, setError] = useState<string | null>(null);

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

  const { connecting: connectingRuntime } =
    useEnsureRuntimeConnection(activeTab);

  /* =============================================================================
   * Engine/metaKey (depends on activeTab)
   * ============================================================================= */
  const metadata = useDatabaseMetadata();
  const engine = activeTab?.engine;

  const metaKey = useMemo(() => {
    if (!activeTab?.profileId) return "";
    return `${engine ?? "postgres"}:${activeTab.profileId}`;
  }, [engine, activeTab?.profileId]);

  /* =============================================================================
   * Table loading (service) + active table data snapshot
   * ============================================================================= */
  const { loadTableData, getTableData, removeTableData } = useLoadTableData();

  const activeTableData = useMemo(() => {
    if (!activeTableWindow) return EMPTY_TABLE_DATA;
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
   * Auto-load active table rows
   * ============================================================================= */
  const lastAutoLoadRef = useRef<string>("");

  useEffect(() => {
    if (!activeProfileScreen || activeProfileScreen === "main") return;
    if (!activeTableWindow) return;
    if (!runtimeConnectionId) return;

    if (activeTableData.busy) return;
    if (activeTableData.data && !activeTableData.error) return;

    const k = `${activeProfileScreen}:${activeTableWindow.id}:${activeTableWindow.table.schema}.${activeTableWindow.table.name}:${limit}:${offset}`;
    if (lastAutoLoadRef.current === k) return;
    lastAutoLoadRef.current = k;

    loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      {
        limit,
        offset,
      }
    ).catch(console.error);
  }, [
    activeProfileScreen,
    activeTableWindow?.id,
    activeTableWindow?.table?.schema,
    activeTableWindow?.table?.name,
    runtimeConnectionId,
    activeTableData.busy,
    activeTableData.data,
    activeTableData.error,
    limit,
    offset,
    loadTableData,
  ]);

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
    schemasForEditor,
    isConnecting,
  } = useSchemaTablesPanel({
    metadata,
    metaKey,
    engine,
    connectionId: runtimeConnectionId,
    defaultSchema: "public",
  });

  const loadError = useMemo(() => {
    return meta.error || (activeTableWindow ? activeTableData.error : null);
  }, [meta.error, activeTableWindow, activeTableData.error]);

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
  });

  // ✅ stable provider value (avoid context rerender cascades)
  const actionsRef = useRef(actionsRaw);
  useEffect(() => {
    actionsRef.current = actionsRaw;
  }, [actionsRaw]);

  const actions = useMemo(() => {
    return {
      openSql: () => actionsRef.current.openSql(),
      refresh: () => actionsRef.current.refresh(),
      saveChanges: () => actionsRef.current.saveChanges(),
      discardChanges: () => actionsRef.current.discardChanges(),
      closeWindow: (id: string, e: MouseEvent) =>
        actionsRef.current.closeWindow(id, e),
      closeTab: (id: string, skip?: boolean) =>
        actionsRef.current.closeTab(id, skip),
      pageChange: (l: number, o: number) => actionsRef.current.pageChange(l, o),
      selectTable: (t: TableItem) => actionsRef.current.selectTable(t),
    };
  }, []);

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
      limit,
      offset,
      loadError,
      runSqlWithHistory,
      refreshSchemaAndTables,
      newTableSaveRef,
    }),
    [
      activeProfileScreen,
      engine,
      metaKey,
      metadata,
      activeSchema,
      runtimeConnectionId,
      limit,
      offset,
      loadError,
      runSqlWithHistory,
      refreshSchemaAndTables,
    ]
  );

  /* =============================================================================
   * Main content layout (no heavy hooks inside)
   * ============================================================================= */
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
            activeWindowId={activeWindowId}
          />
        </div>
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
            activeSchema={activeTableWindow?.table.schema}
            activeTable={activeTableWindow?.table.name}
            viewMode={viewMode}
            loadTableError={loadError}
            onViewModeChange={toggleViewMode}
            openSQLWindow={actions.openSql}
            onRefresh={() => void actions.refresh()}
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
                      currSchema={activeSchema}
                      onSchemaChange={onSchemaChange}
                      tableSearchQuery={tableSearchQuery}
                      setTableSearchQuery={setTableSearchQuery}
                      expandedSections={expandedSections}
                      setExpandedSections={setExpandedSections}
                      filteredTables={filteredTables}
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
        </div>
      </ConnectionRuntimeProvider>
    </ConnectionActionsProvider>
  );
}
