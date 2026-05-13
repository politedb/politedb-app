import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from "preact/hooks";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";
import { usePersistentStore } from "src/stores/persistentStore";

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
import { DiagramGeneratorDialog } from "src/components/modal/DiagramGeneratorDialog";
import {
  appendSqlIntoLiveEditor,
  getLiveSqlEditorContent,
} from "src/components/editor/SqlEditorPane";

import { useConnectionActions } from "./hooks/useConnectionActions";
import { ConnectionActionsProvider } from "./ConnectionActionsContext";
import { ConnectionRuntimeProvider } from "./ConnectionRuntimeContext";
import { useConnectionShortcuts } from "./hooks/useConnectionShortcuts";
import type { TableItem } from "src/types";
import { ConnectingPanel } from "./ConnectingPanel";
import { useProfileStore } from "src/stores/profile";
import type { PatchMap } from "src/utils/generateSql";
import { pickHostDbUser } from "src/utils/connection";

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
const EMPTY_NEW_TABLE_DRAFTS = Object.freeze({}) as Record<
  string,
  { tableName?: string }
>;

function patchMapHasAnyChanges(patchMap: unknown): boolean {
  if (!patchMap || typeof patchMap !== "object") return false;

  for (const entry of Object.values(patchMap as Record<string, unknown>)) {
    const patches = (entry as { patches?: unknown } | undefined)?.patches;
    if (!patches || typeof patches !== "object") continue;

    for (const actionPatches of Object.values(
      patches as Record<string, unknown>
    )) {
      if (!actionPatches || typeof actionPatches !== "object") continue;

      for (const rows of Object.values(
        actionPatches as Record<string, unknown>
      )) {
        if (rows && typeof rows === "object" && Object.keys(rows).length > 0) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasValidNewTableDraft(draft: unknown): boolean {
  if (!draft || typeof draft !== "object") return false;
  const data = draft as {
    tableName?: unknown;
    columns?: Array<{ column_name?: unknown }>;
  };

  return (
    typeof data.tableName === "string" &&
    data.tableName.trim().length > 0 &&
    Array.isArray(data.columns) &&
    data.columns.some(
      (column) =>
        typeof column?.column_name === "string" &&
        column.column_name.trim().length > 0
    )
  );
}

function hasAnyUnsavedConnectionChanges(): boolean {
  const s = useConnectionStore.getState();

  for (const patchMap of Object.values(s.dataPatchMap)) {
    if (patchMapHasAnyChanges(patchMap)) return true;
  }

  for (const tabDrafts of Object.values(s.newTableData)) {
    for (const draft of Object.values(tabDrafts)) {
      if (hasValidNewTableDraft(draft)) return true;
    }
  }

  return false;
}

function discardAllConnectionChanges() {
  const s = useConnectionStore.getState();
  const screen = useScreenStore.getState();
  const tabIds = new Set<string>([
    ...Object.keys(s.dataPatchMap),
    ...Object.keys(s.newTableData),
    ...Object.keys(s.tableStructure),
    ...Object.keys(s.tableConstraints),
    ...Object.keys(screen.openWindows),
  ]);

  for (const tabId of tabIds) {
    const newTableWindowIds = new Set(Object.keys(s.newTableData[tabId] ?? {}));

    s.clearTableConstraints(tabId);
    s.clearTableStructure(tabId);
    s.clearDataPatchMap(tabId);
    s.clearNewTableData(tabId);

    const windows = screen.openWindows[tabId] ?? [];
    const withoutNewTableWindows = windows.filter(
      (window) =>
        window.type !== "table" ||
        (!window.table.new && !newTableWindowIds.has(window.id))
    );
    if (withoutNewTableWindows.length !== windows.length) {
      screen.replaceWindows(tabId, withoutNewTableWindows);
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

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
  const [pendingAppQuit, setPendingAppQuit] = useState(false);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null
  );
  const [pendingTableAction, setPendingTableAction] = useState<
    "export" | "import" | "clone" | "truncate" | "drop" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [rightNavTab, setRightNavTab] = useState<"ai" | "table-size">(
    "table-size"
  );
  const forceQuitRef = useRef(false);

  const quitApp = useCallback(async () => {
    forceQuitRef.current = true;

    try {
      await invoke("app_quit");
    } catch {
      await getCurrentWindow().destroy();
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (forceQuitRef.current) return;

        event.preventDefault();

        if (!hasAnyUnsavedConnectionChanges()) {
          void quitApp();
          return;
        }

        setPendingCloseTabId(null);
        setPendingAppQuit(true);
        setWarningRefresh(true);
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [quitApp]);

  const discardAndQuitApp = useCallback(async () => {
    discardAllConnectionChanges();
    await usePersistentStore.getState().saveNow();

    setWarningRefresh(false);
    setPendingCloseTabId(null);
    setPendingAppQuit(false);

    await quitApp();
  }, [quitApp]);

  const { viewMode, toggleViewMode, setViewMode } = useViewMode([
    "left",
    "bottom",
  ]);

  /* =============================================================================
   * Windows orchestration (depends on activeProfileScreen)
   * ============================================================================= */
  const {
    activeTab,
    windows: activeWindows,
    activeId: activeWindowId,
    activeSqlWindow,
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
  const { getProfileById } = useProfileStore();

  const profile = useMemo(() => {
    if (!activeTab?.profileId) return null;
    return getProfileById(activeTab.profileId);
  }, [activeTab, getProfileById]);

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

  const newTableDrafts = useConnectionStore((s) => {
    if (!activeProfileScreen) return EMPTY_NEW_TABLE_DRAFTS;
    return s.newTableData[activeProfileScreen] ?? EMPTY_NEW_TABLE_DRAFTS;
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
    defaultSchema:
      engine === "postgres"
        ? "public"
        : engine === "redis"
          ? `db ${profile?.input?.redis?.db ?? 0}`
          : "",
  });

  const sidebarTables = useMemo(() => {
    const base = [...filteredTables];
    const draftTables = activeWindows
      .filter(
        (w): w is Extract<(typeof activeWindows)[number], { type: "table" }> =>
          w.type === "table" && !!w.table?.new
      )
      .map((w) => w.table)
      .filter((t) => !activeSchema || t.schema === activeSchema)
      .filter((t) => {
        const q = tableSearchQuery.trim().toLowerCase();
        if (!q) return true;
        return (
          t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)
        );
      });

    const persistedDraftTables = Object.entries(newTableDrafts)
      .map(([windowId, data]) => {
        const rawName = data?.tableName?.trim() ?? "";
        if (!rawName) return null;

        // Window id format is usually "table:<schema>.<name>"
        const key = windowId.startsWith("table:")
          ? windowId.slice(6)
          : windowId;
        const dotIdx = key.indexOf(".");
        const schemaFromWindow =
          dotIdx > 0 ? key.slice(0, dotIdx).trim() : activeSchema;

        return {
          schema: schemaFromWindow || activeSchema,
          name: rawName,
          new: true,
        } as TableItem;
      })
      .filter((t): t is TableItem => !!t)
      .filter((t) => !activeSchema || t.schema === activeSchema)
      .filter((t) => {
        const q = tableSearchQuery.trim().toLowerCase();
        if (!q) return true;
        return (
          t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)
        );
      });

    for (const draft of [...draftTables, ...persistedDraftTables]) {
      if (
        !base.some((t) => t.schema === draft.schema && t.name === draft.name)
      ) {
        base.push(draft);
      }
    }

    return base;
  }, [
    filteredTables,
    activeWindows,
    newTableDrafts,
    activeSchema,
    tableSearchQuery,
  ]);

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
  const sqlSafetyMode =
    activeTab?.querySafetyMode ?? (activeTab?.isLocked ? "lock" : "default");
  const isProfileLocked = sqlSafetyMode === "lock";

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
      renameRedisKey: (table: TableItem, nextName: string) =>
        actionsRef.current.renameRedisKey(table, nextName),
      deleteRedisKey: (table: TableItem) =>
        actionsRef.current.deleteRedisKey(table),
      openSearch: () => setSearchDialogOpen(true),
    };
  }, [isProfileLocked]);

  const patchMap = useMemo(() => {
    return actions.getPatchMap() || ({} as PatchMap);
  }, [actions.getPatchMap()]);

  const newTableSql = useMemo(() => {
    return actions.getNewTableSql().data;
  }, [actions.getNewTableSql().data]);

  const diagramDatabase = useMemo(() => {
    if (!profile) return "";
    return pickHostDbUser(profile).database || "";
  }, [profile]);

  const onInsertSqlIntoActiveEditor = useCallback(
    async (sql: string) => {
      const next = sql.trim();
      if (!next) return;

      let targetWindowId = activeSqlWindow?.id;
      let current =
        (targetWindowId
          ? getLiveSqlEditorContent(targetWindowId)
          : null
        )?.trim() ??
        activeSqlWindow?.content?.trim() ??
        "";
      let title = activeSqlWindow?.title ?? "SQL Query";

      if (!targetWindowId) {
        targetWindowId = openSqlEditor();
      }

      if (!activeSqlWindow && targetWindowId) {
        const windows =
          useScreenStore.getState().openWindows[activeProfileScreen] ?? [];
        const createdWindow = windows.find(
          (window) => window.id === targetWindowId && window.type === "sql"
        );
        if (createdWindow?.type === "sql") {
          current = createdWindow.content?.trim() ?? "";
          title = createdWindow.title ?? "SQL Query";
        }
      }

      if (!targetWindowId) return;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await appendSqlIntoLiveEditor(targetWindowId, next)) {
          return;
        }
        await sleep(50);
      }

      const merged = current ? `${current}\n\n${next}` : next;
      useScreenStore
        .getState()
        .updateSqlWindowContent(activeProfileScreen, targetWindowId, {
          content: merged,
          title,
        });

      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (await appendSqlIntoLiveEditor(targetWindowId, next)) {
          return;
        }
        await sleep(50);
      }
    },
    [activeProfileScreen, activeSqlWindow, openSqlEditor]
  );

  const openAiAssistant = useMemo(() => {
    return () => {
      setViewMode((prev) => {
        const isAiOpen = prev.includes("right") && rightNavTab === "ai";
        if (isAiOpen) {
          return prev.filter((mode) => mode !== "right");
        }

        setRightNavTab("ai");
        return prev.includes("right") ? prev : [...prev, "right"];
      });
    };
  }, [rightNavTab, setViewMode]);

  const openDiagram = useMemo(() => {
    return () => setDiagramOpen(true);
  }, []);

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
      sqlSafetyMode,
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
      sqlSafetyMode,
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
            activeRightPanelTab={rightNavTab}
            isRightPanelOpen={viewMode.includes("right")}
            connectionVersion={meta.version}
            viewMode={viewMode}
            loadTableError={loadError}
            onViewModeChange={toggleViewMode}
            openSQLWindow={actions.openSql}
            onRefresh={() => void actions.refresh()}
            onSearchOpen={() => setSearchDialogOpen(true)}
            onOpenAiAssistant={openAiAssistant}
            onOpenDiagram={openDiagram}
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
                      schemaLabel={
                        engine === "mongo" || engine === "redis"
                          ? "Database"
                          : "Schema"
                      }
                      tablesSectionTitle={
                        engine === "mongo"
                          ? "Collections"
                          : engine === "redis"
                            ? "Keys"
                            : "Tables"
                      }
                      tableSearchQuery={tableSearchQuery}
                      setTableSearchQuery={setTableSearchQuery}
                      expandedSections={expandedSections}
                      setExpandedSections={setExpandedSections}
                      filteredTables={sidebarTables}
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
                            <RightNav
                              chatSessionKey={activeProfileScreen}
                              activeTab={rightNavTab}
                              onTabChange={setRightNavTab}
                              sizeInfo={activeTableData.sizeInfo}
                              engine={engine || "postgres"}
                              runtimeConnectionId={runtimeConnectionId}
                              activeSchema={activeSchema}
                              tables={meta.tables}
                              columnsByTable={meta.columnsByTable}
                              currentSql={activeSqlWindow?.content}
                              onInsertSql={onInsertSqlIntoActiveEditor}
                            />
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
                        <RightNav
                          chatSessionKey={activeProfileScreen}
                          activeTab={rightNavTab}
                          onTabChange={setRightNavTab}
                          sizeInfo={activeTableData.sizeInfo}
                          engine={engine || "postgres"}
                          runtimeConnectionId={runtimeConnectionId}
                          activeSchema={activeSchema}
                          tables={meta.tables}
                          columnsByTable={meta.columnsByTable}
                          currentSql={activeSqlWindow?.content}
                          onInsertSql={onInsertSqlIntoActiveEditor}
                        />
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
              setPendingAppQuit(false);
            }}
            onDiscard={() => {
              if (pendingAppQuit) {
                void discardAndQuitApp();
                return;
              }

              void actions.discardChanges();
            }}
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
          schemaLabel={
            engine === "mongo" || engine === "redis" ? "Database" : "Schema"
          }
          onSelectTable={(table) => void actions.selectTable(table)}
          onSelectSchema={onSchemaChange}
        />

        <DiagramGeneratorDialog
          open={diagramOpen}
          onClose={() => setDiagramOpen(false)}
          engine={engine}
          database={diagramDatabase}
          schema={activeSchema}
          connectionId={runtimeConnectionId}
          metaKey={metaKey}
          metadata={metadata}
        />
      </ConnectionRuntimeProvider>
    </ConnectionActionsProvider>
  );
}
