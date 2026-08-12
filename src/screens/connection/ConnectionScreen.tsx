import { useMemo, useEffect, useRef, useCallback } from "preact/hooks";

import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";
import { getTablePagination } from "./tablePagination";

import { MenuBar } from "./MenuBar";
import { Box } from "src/components/common/Box";
import { ConnectionWorkspaceLayout } from "./ConnectionWorkspaceLayout";

import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useViewMode } from "./hooks/useViewMode";
import { useSqlHistoryRunner } from "./hooks/useSqlHistoryRunner";
import { useSchemaTablesPanel } from "./hooks/useSchemaTablesPanel";
import { useDatabaseMetadata } from "src/hooks/useDatabaseMetadata";
import { useEnsureRuntimeConnection } from "src/hooks/useEnsureRuntimeConnection";
import { resolveTabRuntimeConnectionId } from "src/lib/runtimeConnection";
import { resolveDefaultSchema } from "src/lib/engines";

import { ErrorDialog } from "src/components/modal/ErrorDialog";
import { SaveChangesDialog } from "src/components/modal/SaveChangesDialog";
import { DatabaseSearchDialog } from "src/components/modal/DatabaseSearchDialog";
import { DiagramGeneratorDialog } from "src/components/modal/DiagramGeneratorDialog";
import { OverlayModal } from "src/components/modal/OverlayModal";
import { ConnectionFormDialog } from "src/components/connection/ConnectionFormDialog";
import type { ConnectionProfile } from "src/lib/tauri";

import { useConnectionActions } from "./hooks/useConnectionActions";
import { ConnectionActionsProvider } from "./ConnectionActionsContext";
import { ConnectionRuntimeProvider } from "./ConnectionRuntimeContext";
import { useConnectionShortcuts } from "./hooks/useConnectionShortcuts";
import { useRefreshTrigger } from "./hooks/useRefreshTrigger";
import { registerConnectionTabCloseBridge } from "./connectionTabCloseBridge";
import type { TableItem } from "src/types";
import { ConnectingPanel } from "./ConnectingPanel";
import { useProfileStore } from "src/stores/profile";
import {
  currentDatabaseFromInput,
  inferDatabaseOverrideFromTabLabel,
} from "src/utils/connection";
import type { PatchMap } from "src/utils/generateSql";
import { pickHostDbUser } from "src/utils/connection";
import { tableRowsStreamLoadPercent } from "src/utils/tableRowsProgress";
import { useConnectionQuitGuard } from "./hooks/useConnectionQuitGuard";
import { useConnectionScreenState } from "./hooks/useConnectionScreenState";
import { useInsertSqlIntoActiveEditor } from "./hooks/useInsertSqlIntoActiveEditor";
import { useFloatingAssistantStore } from "src/stores/floatingAssistant";
import { OPEN_FLOATING_ASSISTANT_EVENT } from "src/components/ai-assistant/FloatingAssistantLauncher";

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

  const {
    getProfileById,
    showEditProfile,
    selectedProfileId,
    closeEdit,
    saveProfile,
    loadProfiles,
  } = useProfileStore();

  const activeProfileTab = useMemo(
    () => profileTabs.find((tab) => tab.id === activeProfileScreen) ?? null,
    [profileTabs, activeProfileScreen]
  );

  const profile = useMemo(() => {
    if (!activeProfileTab?.profileId) return null;
    return getProfileById(activeProfileTab.profileId);
  }, [activeProfileTab?.profileId, getProfileById]);

  const engine = activeProfileTab?.engine;

  const activeDatabaseOverride = useMemo(() => {
    return (
      activeProfileTab?.databaseOverride ??
      inferDatabaseOverrideFromTabLabel(profile?.label, activeProfileTab?.label)
    );
  }, [
    activeProfileTab?.databaseOverride,
    activeProfileTab?.label,
    profile?.label,
  ]);

  const sqlScopeKey = useMemo(() => {
    if (!profile) return activeProfileScreen;
    const { host, database, user } = pickHostDbUser(profile);
    const activeDatabase = activeDatabaseOverride || database;
    return [
      profile.id,
      profile.engine,
      host.trim(),
      activeDatabase.trim(),
      user.trim(),
    ].join(":");
  }, [activeProfileScreen, activeDatabaseOverride, profile]);

  /* =============================================================================
   * Local UI state (screen-level)
   * ============================================================================= */
  const {
    limit,
    setLimit,
    offset,
    setOffset,
    pendingTableAction,
    setPendingTableAction,
    error,
    setError,
    showSaveDialog,
    setShowSaveDialog,
    searchDialogOpen,
    setSearchDialogOpen,
    diagramOpen,
    setDiagramOpen,
    errorDialogOpen,
    setErrorDialogOpen,
  } = useConnectionScreenState();
  const { discardAndQuitApp } = useConnectionQuitGuard();

  const { viewMode, toggleViewMode } = useViewMode(["left", "bottom"]);

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
    openDatabaseObjectsManager,
    closeWindow,
  } = useConnectionWindows(activeProfileScreen, sqlScopeKey);

  const activeTablePagination = useMemo(() => {
    if (!activeTableWindow) return null;
    return getTablePagination(activeTableWindow.id);
  }, [activeTableWindow?.id, limit, offset]);
  const currentLimit = activeTablePagination?.limit ?? limit;
  const currentOffset = activeTablePagination?.offset ?? offset;

  const {
    connecting: connectingRuntime,
    error: errorRuntime,
    setError: setRuntimeConnectionError,
    reload: reloadRuntime,
  } = useEnsureRuntimeConnection(activeTab);

  useEffect(() => {
    setErrorDialogOpen(!!errorRuntime);
  }, [errorRuntime]);

  /* =============================================================================
   * Engine/metaKey (depends on activeTab)
   * ============================================================================= */
  const metadata = useDatabaseMetadata();
  const currentDatabase = useMemo(
    () =>
      activeDatabaseOverride ||
      currentDatabaseFromInput(engine, profile?.input),
    [activeDatabaseOverride, engine, profile?.input]
  );

  const editProfile = useMemo(() => {
    if (!selectedProfileId) return undefined;
    return getProfileById(selectedProfileId);
  }, [selectedProfileId, getProfileById]);

  const handleConnectionProfileSaved = useCallback(
    async (saved?: ConnectionProfile) => {
      if (!saved || !activeTab) return;

      await saveProfile(saved);
      await loadProfiles();
      closeEdit();
      setErrorDialogOpen(false);

      const currentTab =
        useScreenStore
          .getState()
          .profileTabs.find((t) => t.id === activeTab.id) ?? activeTab;

      // Connect path sets runtimeConnectionId on the tab; Save-only clears it to retry.
      const runtimeConnectionId = currentTab.runtimeConnectionId;

      useScreenStore.getState().updateTab(activeTab.id, {
        label: saved.label || activeTab.label,
        engine: saved.engine,
        profileId: saved.id,
        runtimeConnectionId: runtimeConnectionId ?? undefined,
      });

      if (runtimeConnectionId) {
        setRuntimeConnectionError(null);
      }
    },
    [activeTab, saveProfile, loadProfiles, closeEdit, setRuntimeConnectionError]
  );

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

  const activeTableLoadKey = useMemo(() => {
    if (!activeTableWindow || activeProfileScreen === "main") return null;
    return tableKey(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [
    activeProfileScreen,
    activeTableWindow,
    activeTableWindow?.table?.schema,
    activeTableWindow?.table?.name,
  ]);

  const rowsStreamState = useConnectionStore((s) => {
    if (!activeTableLoadKey) return null;
    return s.tableRowsByKey[activeTableLoadKey] ?? null;
  });

  const selectedRowDetail = useConnectionStore((s) => {
    if (!activeTableLoadKey) return null;
    return s.selectedRowByKey[activeTableLoadKey] ?? null;
  });

  const tableRowsLoadPercent = useMemo(() => {
    if (!rowsStreamState?.running) return null;
    return tableRowsStreamLoadPercent(
      rowsStreamState,
      activeTableData.rowCount as number | null | undefined
    );
  }, [rowsStreamState, activeTableData.rowCount]);

  /* =============================================================================
   * runtimeConnectionId (derived from tab runtime conn OR table conn)
   * NOTE: this is where store + windows + tab meet
   * ============================================================================= */
  const runtimeConnectionId = useConnectionStore((s) =>
    resolveTabRuntimeConnectionId({
      tabRuntimeConnectionId: activeTab?.runtimeConnectionId,
      activeProfileScreen,
      tableDataMap: s.tableDataMap,
    })
  );

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
    currentDatabase,
    defaultSchema: resolveDefaultSchema(engine, {
      currentDatabase,
      redisDb: profile?.input?.redis?.db ?? 0,
    }),
  });

  const prevRuntimeConnectionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const prev = prevRuntimeConnectionIdRef.current;
    prevRuntimeConnectionIdRef.current = runtimeConnectionId;

    if (!runtimeConnectionId || runtimeConnectionId === prev) return;

    setRuntimeConnectionError(null);
    setErrorDialogOpen(false);
    void refreshSchemaAndTables();
  }, [runtimeConnectionId, refreshSchemaAndTables, setRuntimeConnectionError]);

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
    const tableErr = activeTableWindow ? activeTableData.error : null;

    if (!runtimeConnectionId) {
      return errorRuntime || meta.error || tableErr;
    }

    // Connected: ignore stale runtime error; only show metadata error if load never succeeded.
    const metadataErr = meta.error && !meta.loaded ? meta.error : null;
    return metadataErr || tableErr;
  }, [
    runtimeConnectionId,
    errorRuntime,
    meta.error,
    meta.loaded,
    activeTableWindow,
    activeTableData.error,
  ]);

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

    limit: currentLimit,
    offset: currentOffset,
    setLimit,
    setOffset,

    setError,
    setShowSaveDialog,

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

  const { isRefreshing, triggerRefresh } = useRefreshTrigger(() =>
    actionsRef.current.refresh()
  );

  const discardAndQuitAppRef = useRef(discardAndQuitApp);
  discardAndQuitAppRef.current = discardAndQuitApp;

  useEffect(() => {
    registerConnectionTabCloseBridge({
      closeTab: (tabId, skipCheck) =>
        actionsRef.current.closeTab(tabId, skipCheck),
      discardChanges: () => actionsRef.current.discardChanges(),
      discardAndQuitApp: () => discardAndQuitAppRef.current(),
    });
    return () => registerConnectionTabCloseBridge(null);
  }, []);

  const sqlSafetyMode =
    activeTab?.querySafetyMode ?? (activeTab?.isLocked ? "lock" : "default");
  const isProfileLocked = sqlSafetyMode === "lock";

  const actions = useMemo(() => {
    return {
      openSql: () => actionsRef.current.openSql(),
      refresh: triggerRefresh,
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
  }, [isProfileLocked, triggerRefresh]);

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

  const onInsertSqlIntoActiveEditor = useInsertSqlIntoActiveEditor({
    activeProfileScreen,
    activeSqlWindow,
    openSqlEditor,
  });

  useEffect(() => {
    if (!activeTab || !engine) return;

    useFloatingAssistantStore.getState().setContext({
      scopeKey: activeProfileScreen,
      engine,
      runtimeConnectionId,
      activeSchema,
      activeTable: activeTableWindow?.table,
      tables: meta.tables,
      columnsByTable: meta.columnsByTable,
      columnDetailsByTable: meta.columnDetailsByTable,
      currentSql: activeSqlWindow?.content,
      querySafetyMode: sqlSafetyMode,
      onInsertSql: onInsertSqlIntoActiveEditor,
    });

    return () => {
      useFloatingAssistantStore.getState().clearContext(activeProfileScreen);
    };
  }, [
    activeProfileScreen,
    activeTab,
    engine,
    runtimeConnectionId,
    activeSchema,
    activeTableWindow?.table,
    meta.tables,
    meta.columnsByTable,
    meta.columnDetailsByTable,
    activeSqlWindow?.content,
    sqlSafetyMode,
    onInsertSqlIntoActiveEditor,
  ]);

  const openAiAssistant = useCallback(() => {
    window.dispatchEvent(new Event(OPEN_FLOATING_ASSISTANT_EVENT));
  }, []);

  const openDiagram = useMemo(() => {
    return () => setDiagramOpen(true);
  }, []);

  const openDatabaseObjects = useMemo(() => {
    return () => {
      openDatabaseObjectsManager();
    };
  }, [openDatabaseObjectsManager]);

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
      sqlScopeKey,
      metaKey,
      metadata,
      activeSchema,
      runtimeConnectionId,
      isProfileLocked,
      sqlSafetyMode,
      limit: currentLimit,
      offset: currentOffset,
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
      sqlScopeKey,
      metaKey,
      metadata,
      activeSchema,
      runtimeConnectionId,
      isProfileLocked,
      sqlSafetyMode,
      currentLimit,
      currentOffset,
      loadError,
      runSqlWithHistory,
      refreshSchemaAndTables,
      pendingTableAction,
    ]
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
            tableRowsLoadPercent={tableRowsLoadPercent}
            onViewModeChange={toggleViewMode}
            openSQLWindow={actions.openSql}
            onRefresh={triggerRefresh}
            isRefreshing={isRefreshing}
            onSearchOpen={() => setSearchDialogOpen(true)}
            onOpenAiAssistant={openAiAssistant}
            onOpenDiagram={openDiagram}
            onOpenDatabaseObjects={openDatabaseObjects}
          />

          <ConnectionWorkspaceLayout
            viewMode={viewMode}
            activeWindows={activeWindows}
            activeWindowId={activeWindowId}
            selectWindow={selectWindow}
            activeProfileScreen={activeProfileScreen}
            engine={engine}
            schemasForEditor={schemasForEditor}
            activeSchema={activeSchema}
            onSchemaChange={onSchemaChange}
            tableSearchQuery={tableSearchQuery}
            setTableSearchQuery={setTableSearchQuery}
            expandedSections={expandedSections}
            setExpandedSections={setExpandedSections}
            sidebarTables={sidebarTables}
            filteredFunctions={filteredFunctions}
            activeTableDataSizeInfo={activeTableData.sizeInfo}
            selectedRowDetail={selectedRowDetail}
            activeTableLoadKey={activeTableLoadKey}
            isProfileLocked={isProfileLocked}
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
              getOriginalRowAt={useConnectionStore.getState().getOriginalRowAt}
              offset={currentOffset}
            />
          )}
        </div>

        {errorDialogOpen && (
          <ErrorDialog
            open
            error={errorRuntime ?? ""}
            onClose={() => setErrorDialogOpen(false)}
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

        <OverlayModal
          open={
            !!(
              showEditProfile &&
              editProfile &&
              activeTab?.profileId === editProfile.id
            )
          }
          onClose={closeEdit}
        >
          {editProfile ? (
            <ConnectionFormDialog
              onSaved={handleConnectionProfileSaved}
              onClose={closeEdit}
              initialData={editProfile}
              engine={editProfile.engine}
              reuseTabId={activeTab?.id}
            />
          ) : null}
        </OverlayModal>
      </ConnectionRuntimeProvider>
    </ConnectionActionsProvider>
  );
}
