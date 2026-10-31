import { rememberAiChatOwner } from "src/components/ai-assistant/hooks/useAiChatSession";
import { mergeSidebarTables } from "./lib/newTableDrafts";
import {
  useMemo,
  useEffect,
  useRef,
  useCallback,
  useState,
} from "preact/hooks";

import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";
import { getTablePagination } from "./lib/tablePagination";

import { MenuBar } from "./workspace/MenuBar";
import { Box } from "src/components/common/Box";
import { ConnectionWorkspaceLayout } from "./workspace/ConnectionWorkspaceLayout";

import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useViewMode } from "./hooks/useViewMode";
import { useSqlHistoryRunner } from "./hooks/useSqlHistoryRunner";
import { useTableDestructiveActions } from "./hooks/useTableDestructiveActions";
import { TruncateTableDialog } from "src/components/modal/TruncateTableDialog";
import { useSchemaTablesPanel } from "./hooks/useSchemaTablesPanel";
import { useDatabaseMetadata } from "src/hooks/useDatabaseMetadata";
import { useEnsureRuntimeConnection } from "src/hooks/useEnsureRuntimeConnection";
import {
  resolveTabRuntimeConnectionId,
  tabLabelFor,
} from "src/lib/runtimeConnection";
import { resolveTabTarget } from "src/lib/tabs/tabTarget";
import { resolveDefaultSchema } from "src/lib/engines";

import { showMessage } from "src/lib/system-dialog";
import { SaveChangesDialog } from "src/components/modal/SaveChangesDialog";
import { DatabaseSearchDialog } from "src/components/modal/DatabaseSearchDialog";
import { SnippetPickerDialog } from "src/components/modal/SnippetPickerDialog";
import { SnippetEditorDialog } from "src/components/modal/SnippetEditorDialog";
import type { SavedSnippet } from "src/lib/snippets/types";
import { DiagramGeneratorDialog } from "src/components/modal/DiagramGeneratorDialog";
import { DbHealthInspectorDialog } from "@root/src/components/health-inspector/DbHealthInspectorDialog";
import { OverlayModal } from "src/components/modal/OverlayModal";
import { ConnectionFormDialog } from "src/components/connection/ConnectionFormDialog";
import type { ConnectionProfile } from "src/lib/tauri";
import {
  findSnippetByHotkey,
  listVisibleSnippets,
} from "src/lib/snippets/library";
import { useSnippetsStore } from "src/stores/snippets";

import { useConnectionActions } from "./hooks/useConnectionActions";
import { metaKeyForTab, type ObjectMetadataRefresh } from "./lib/objectWindows";
import { reconcileObjectDraftsOnMetadataLoads } from "./lib/objectReconcile";
import { saveFailureMessages } from "./lib/saveJobs";
import { useObjectSaveReview } from "./hooks/useObjectSaveReview";
import { ConnectionActionsProvider } from "./workspace/ConnectionActionsContext";
import { ConnectionRuntimeProvider } from "./workspace/ConnectionRuntimeContext";
import { useConnectionShortcuts } from "./hooks/useConnectionShortcuts";
import { useRefreshTrigger } from "./hooks/useRefreshTrigger";
import { registerConnectionTabCloseBridge } from "./lib/connectionTabCloseBridge";
import type { TableItem } from "src/types";
import { ConnectingPanel } from "./workspace/ConnectingPanel";
import { TabTargetBanner } from "./workspace/TabTargetBanner";
import { isReconnectMessage } from "src/lib/tabs/assertTabTarget";
import { useProfileStore } from "src/stores/profile";
import { currentDatabaseFromInput } from "src/lib/connection/connection";
import type { PatchMap } from "src/lib/patches/generateSql";
import { pickHostDbUser } from "src/lib/connection/connection";
import { tableRowsStreamLoadPercent } from "src/utils/tableRowsProgress";
import { useConnectionQuitGuard } from "./hooks/useConnectionQuitGuard";
import { useConnectionScreenState } from "./hooks/useConnectionScreenState";
import { useInsertSqlIntoActiveEditor } from "./hooks/useInsertSqlIntoActiveEditor";
import { StandaloneTableExportHost } from "./export/StandaloneTableExportHost";
import { StandaloneTableImportHost } from "./import/StandaloneTableImportHost";
import { StandaloneSqlDumpImportHost } from "./import/StandaloneSqlDumpImportHost";
import {
  forgetImportedTableRows,
  importNeedsTableTab,
} from "./import/standaloneImport";
import type { StandaloneExportTarget } from "./export/standalone-export/types";
import { canStandaloneExportTable } from "./export/standalone-export/support";
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
  { tableName?: string; schema?: string; windowName?: string }
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

  // What this tab is opened on (R2): its target only, never its label.
  const activeTarget = useMemo(
    () => resolveTabTarget(activeProfileTab, profile),
    [activeProfileTab, profile]
  );
  const activeDatabaseOverride = activeTarget.intended?.override ?? "";

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
    staleTableKey,
    setStaleTableKey,
    error,
    setError,
    showSaveDialog,
    setShowSaveDialog,
    searchDialogOpen,
    setSearchDialogOpen,
    snippetPickerOpen,
    setSnippetPickerOpen,
    diagramOpen,
    setDiagramOpen,
    healthInspectorOpen,
    setHealthInspectorOpen,
  } = useConnectionScreenState();
  const { discardAndQuitApp } = useConnectionQuitGuard();
  const [snippetEditorOpen, setSnippetEditorOpen] = useState(false);
  const [snippetEditorInitial, setSnippetEditorInitial] = useState<
    (Partial<SavedSnippet> & { sql?: string }) | undefined
  >(undefined);
  const [standaloneExportTarget, setStandaloneExportTarget] =
    useState<StandaloneExportTarget | null>(null);
  const clearStandaloneExportTarget = useCallback(() => {
    setStandaloneExportTarget(null);
  }, []);
  // SQL dump import started from the sidebar without opening the table.
  const [standaloneDumpTarget, setStandaloneDumpTarget] =
    useState<StandaloneExportTarget | null>(null);
  const clearStandaloneDumpTarget = useCallback(() => {
    setStandaloneDumpTarget(null);
  }, []);
  // CSV import started from the sidebar without opening the table.
  const [standaloneImportTarget, setStandaloneImportTarget] =
    useState<StandaloneExportTarget | null>(null);
  const clearStandaloneImportTarget = useCallback(() => {
    setStandaloneImportTarget(null);
  }, []);
  const snippetLibrary = useSnippetsStore((s) => s.library);
  const ensureSnippetsLoaded = useSnippetsStore((s) => s.ensureLoaded);

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
    closeWindow,
    closeWindows,
    openDatabaseObjectsManager,
  } = useConnectionWindows(activeProfileScreen, sqlScopeKey);

  const activeTablePagination = useMemo(() => {
    if (!activeTableWindow) return null;
    return getTablePagination(activeTableWindow.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // The tab itself asks to reconnect (or says it must be reopened).
    if (!errorRuntime || isReconnectMessage(errorRuntime)) return;
    void showMessage(errorRuntime, {
      title: "Connection error",
      kind: "error",
    });
  }, [errorRuntime]);

  useEffect(() => {
    if (!error) return;
    void showMessage(error, { title: "Error", kind: "error" }).then(() => {
      setError(null);
    });
  }, [error, setError]);

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
      const currentTab =
        useScreenStore
          .getState()
          .profileTabs.find((t) => t.id === activeTab.id) ?? activeTab;

      // Connect path sets runtimeConnectionId on the tab; Save-only clears it to retry.
      const runtimeConnectionId = currentTab.runtimeConnectionId;

      useScreenStore.getState().updateTab(activeTab.id, {
        label: saved.label
          ? tabLabelFor(saved.label, currentTab.target)
          : activeTab.label,
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
    return metaKeyForTab({ id: activeTab.id, engine });
  }, [engine, activeTab?.id]);

  // The tab's epoch moved (new connection, profile saved again, connection
  // refused): metadata loaded or loading before is not this tab's any more
  // (R5); it reloads on demand.
  const activeTabEpoch = useScreenStore((s) =>
    activeTab?.id ? (s.tabEpoch[activeTab.id] ?? 0) : 0
  );
  const seenEpochRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const tabId = activeTab?.id;
    if (!tabId || !metaKey) return;
    const seen = seenEpochRef.current[tabId];
    seenEpochRef.current[tabId] = activeTabEpoch;
    if (seen !== undefined && seen !== activeTabEpoch) {
      metadata.clear({ metaKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTabEpoch, metaKey]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTableWindow?.id,
    activeTableWindow?.table?.schema,
    activeTableWindow?.table?.name,
    getTableData,
    activeProfileScreen,
  ]);

  const activeTableLoadKey = useMemo(() => {
    if (!activeTableWindow || activeProfileScreen === "main") return null;
    return tableKey(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [activeProfileScreen, activeTableWindow]);

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
    filteredViews,
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
    void refreshSchemaAndTables();
  }, [runtimeConnectionId, refreshSchemaAndTables, setRuntimeConnectionError]);

  const sidebarTables = useMemo(
    () =>
      mergeSidebarTables({
        tables: filteredTables,
        windows: activeWindows,
        drafts: newTableDrafts,
        activeSchema,
        search: tableSearchQuery,
      }),
    [
      filteredTables,
      activeWindows,
      newTableDrafts,
      activeSchema,
      tableSearchQuery,
    ]
  );

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

  // Object drafts follow every complete metadata load (missing objects).
  useEffect(() => reconcileObjectDraftsOnMetadataLoads(), []);

  // Fresh metadata for any connection screen tab, read from the live store,
  // so the object save and its toast's Open action check the right tab.
  const refreshObjectMetadata = useCallback<ObjectMetadataRefresh>(
    async (screenTabId) => {
      const tab = useScreenStore
        .getState()
        .profileTabs.find((t) => t.id === screenTabId);
      const metaKeyOfTab = tab ? metaKeyForTab(tab) : "";
      const connectionId = tab?.runtimeConnectionId;
      if (!tab || !connectionId) {
        return {
          ok: false,
          metaKey: metaKeyOfTab,
          connectionId: connectionId ?? "",
          error: "No active connection.",
        };
      }
      return metadata.refreshWithOutcome({
        metaKey: metaKeyOfTab,
        engine: tab.engine,
        connectionId,
        currentDatabase: resolveTabTarget(tab, getProfileById(tab.profileId))
          .display,
      });
    },
    [metadata.refreshWithOutcome, getProfileById]
  );

  /* =============================================================================
   * SQL history runner (depends on engine + metadata + profileId)
   * ============================================================================= */
  const { runSqlWithHistory, captureHistoryTarget } = useSqlHistoryRunner({
    engine,
    metadata,
    profileId: activeProfileScreen,
    currentDatabase,
  });
  // Work run from this screen's windows belongs to this tab, fixed when it
  // starts, whichever tab is active later (D3).
  const runSqlInTab = useCallback(
    (args: { connectionId: string; sql: string; windowId?: string }) =>
      runSqlWithHistory({ ...args, tabId: activeProfileScreen }),
    [runSqlWithHistory, activeProfileScreen]
  );

  // While the review dialog runs a save, errors go to that dialog (which
  // stays open and shows them) instead of a separate error message.
  const saveErrorsRef = useRef<string[] | null>(null);
  const reportError = useCallback(
    (message: string | null) => {
      if (message && saveErrorsRef.current) {
        saveErrorsRef.current.push(message);
        return;
      }
      setError(message);
    },
    [setError]
  );

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

    setError: reportError,
    setShowSaveDialog,

    loadTableData,
    removeTableData,
    refreshSchemaAndTables,
    runSqlWithHistory,

    openSqlEditor,
    openTable,
    closeWindow,
    closeWindows,

    removeTab,
    setActiveProfileScreen,

    newTableSaveRef,
    refreshRuntimeConnection: reloadRuntime,
    refreshObjectMetadata,
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

  const onInsertSqlIntoActiveEditor = useInsertSqlIntoActiveEditor({
    activeSqlWindow,
    openSqlEditor,
  });

  const connectionProfileId = activeProfileTab?.profileId ?? null;

  const visibleSearchSnippets = useMemo(
    () => listVisibleSnippets(snippetLibrary, connectionProfileId),
    [snippetLibrary, connectionProfileId]
  );

  const insertSnippetSql = useCallback(
    async (sql: string) => {
      await onInsertSqlIntoActiveEditor(sql, { mode: "cursor" });
    },
    [onInsertSqlIntoActiveEditor]
  );

  useEffect(() => {
    void ensureSnippetsLoaded();
  }, [ensureSnippetsLoaded]);

  const {
    dropTable: dropTableFromTree,
    openTruncate,
    truncateTarget,
    closeTruncate,
    confirmTruncate,
  } = useTableDestructiveActions({
    tabId: activeProfileScreen,
    isProfileLocked,
    engine,
    connectionId: runtimeConnectionId,
    windows: activeWindows,
    runSqlWithHistory,
    refreshSchemaAndTables,
    closeWindow: (id, e) => actionsRef.current.closeWindow(id, e),
    markTableStale: setStaleTableKey,
  });

  const actions = useMemo(() => {
    return {
      openSql: () => actionsRef.current.openSql(),
      refresh: triggerRefresh,
      getPatchMap: () => actionsRef.current.getPatchMap(),
      getNewTableSql: () => actionsRef.current.getNewTableSql(),
      getObjectSql: () => actionsRef.current.getObjectSql(),
      getObjectChangeSummary: () => actionsRef.current.getObjectChangeSummary(),
      getObjectSaveNotices: () => actionsRef.current.getObjectSaveNotices(),
      beforeSaveChanges: () => actionsRef.current.beforeSaveChanges(),
      saveChanges: () => actionsRef.current.saveChanges(),
      discardChanges: () => actionsRef.current.discardChanges(),
      closeWindow: (id: string, e: MouseEvent) =>
        actionsRef.current.closeWindow(id, e),
      closeWindows: (ids: string[]) => actionsRef.current.closeWindows(ids),
      closeTab: (id: string, skip?: boolean) =>
        actionsRef.current.closeTab(id, skip),
      pageChange: (l: number, o: number) => actionsRef.current.pageChange(l, o),
      selectTable: (t: TableItem) => actionsRef.current.selectTable(t),
      openTableStructure: (table: TableItem) => {
        void actionsRef.current.selectTable(table).then(() => {
          setPendingTableAction("structure");
        });
      },
      exportTableData: (table: TableItem) => {
        if (isProfileLocked) return;
        if (table.new) return;
        if (!canStandaloneExportTable(engine)) return;
        const connectionId = runtimeConnectionId;
        if (!connectionId || !engine) return;
        // Single target slot per connection host — replaces any prior session.
        setStandaloneExportTarget({
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          connectionId,
          engine,
          schema: table.schema,
          tableName: table.name,
          kind: table.kind,
          estimatedRow: table.estimatedRow,
        });
      },
      importTableData: (table: TableItem) => {
        if (isProfileLocked) return;
        const connectionId = runtimeConnectionId;
        // Import without opening the table, unless its tab is open or holds
        // unsaved row changes (then the tab handles it, as before).
        if (
          table.new ||
          !connectionId ||
          !engine ||
          !canStandaloneExportTable(engine) ||
          importNeedsTableTab(activeProfileScreen, table)
        ) {
          void actionsRef.current.selectTable(table).then(() => {
            setPendingTableAction("import");
          });
          return;
        }
        setStandaloneImportTarget({
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          connectionId,
          engine,
          schema: table.schema,
          tableName: table.name,
          kind: table.kind,
        });
      },
      importTableSqlDump: (table: TableItem) => {
        if (isProfileLocked) return;
        const connectionId = runtimeConnectionId;
        // Like CSV import: without opening the table, unless its tab is
        // open or holds unsaved row changes (then the tab asks first).
        if (
          table.new ||
          !connectionId ||
          !engine ||
          importNeedsTableTab(activeProfileScreen, table)
        ) {
          void actionsRef.current.selectTable(table).then(() => {
            setPendingTableAction("importSqlDump");
          });
          return;
        }
        setStandaloneDumpTarget({
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          connectionId,
          engine,
          schema: table.schema,
          tableName: table.name,
          kind: table.kind,
        });
      },
      cloneTable: (table: TableItem) => {
        if (isProfileLocked) return;
        void actionsRef.current.selectTable(table).then(() => {
          setPendingTableAction("clone");
        });
      },
      // Neither opens the table: drop asks natively, truncate opens its dialog here.
      truncateTable: (table: TableItem) => openTruncate(table),
      dropTable: (table: TableItem) => void dropTableFromTree(table),
      renameRedisKey: (table: TableItem, nextName: string) =>
        actionsRef.current.renameRedisKey(table, nextName),
      deleteRedisKey: (table: TableItem) =>
        actionsRef.current.deleteRedisKey(table),
      openSearch: () => setSearchDialogOpen(true),
      openSnippets: () => setSnippetPickerOpen(true),
      insertSnippetByHotkey: (binding: string) => {
        const snippet = findSnippetByHotkey(
          snippetLibrary,
          connectionProfileId,
          binding
        );
        if (!snippet) return false;
        void insertSnippetSql(snippet.sql);
        return true;
      },
    };
  }, [
    isProfileLocked,
    setPendingTableAction,
    openTruncate,
    dropTableFromTree,
    setSearchDialogOpen,
    setSnippetPickerOpen,
    triggerRefresh,
    snippetLibrary,
    connectionProfileId,
    insertSnippetSql,
    engine,
    runtimeConnectionId,
    activeProfileScreen,
  ]);

  const patchMap = useMemo(() => {
    return actions.getPatchMap() || ({} as PatchMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.getPatchMap()]);

  const newTableSql = useMemo(() => {
    return actions.getNewTableSql().data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.getNewTableSql().data]);

  const { objectSql, objectChangeSummary, objectSaveNotices } =
    useObjectSaveReview({
      tabId: activeProfileScreen,
      engine,
      open: showSaveDialog,
    });

  // "Connection · database" for the save review.
  const saveTargetLabel = useMemo(
    () =>
      [activeTab?.label, currentDatabase].filter((part) => !!part).join(" · "),
    [activeTab?.label, currentDatabase]
  );

  const diagramDatabase = useMemo(() => {
    if (!profile) return "";
    return activeDatabaseOverride || pickHostDbUser(profile).database || "";
  }, [profile, activeDatabaseOverride]);

  useEffect(() => {
    if (!activeTab || !engine) return;

    rememberAiChatOwner(activeProfileScreen, activeTab.profileId);
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
  }, [setDiagramOpen]);

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
      runSqlWithHistory: runSqlInTab,
      captureHistoryTarget,
      refreshSchemaAndTables,
      newTableSaveRef,
      pendingTableAction,
      setPendingTableAction,
      staleTableKey,
      setStaleTableKey,
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
      runSqlInTab,
      captureHistoryTarget,
      refreshSchemaAndTables,
      pendingTableAction,
      setPendingTableAction,
      staleTableKey,
      setStaleTableKey,
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
            onOpenHealthInspector={() => setHealthInspectorOpen(true)}
          />

          <TabTargetBanner
            tabId={activeProfileScreen}
            target={activeTarget}
            runtimeId={runtimeConnectionId}
            onReconnect={() => void reloadRuntime()}
          />

          <ConnectionWorkspaceLayout
            viewMode={viewMode}
            activeWindows={activeWindows}
            activeWindowId={activeWindowId}
            selectWindow={selectWindow}
            activeProfileScreen={activeProfileScreen}
            connectionProfileId={connectionProfileId}
            onInsertSnippet={insertSnippetSql}
            engine={engine}
            schemasForEditor={schemasForEditor}
            activeSchema={activeSchema}
            onSchemaChange={onSchemaChange}
            tableSearchQuery={tableSearchQuery}
            setTableSearchQuery={setTableSearchQuery}
            expandedSections={expandedSections}
            setExpandedSections={setExpandedSections}
            sidebarTables={sidebarTables}
            filteredViews={filteredViews}
            activeTableDataSizeInfo={activeTableData.sizeInfo}
            selectedRowDetail={selectedRowDetail}
            activeTableLoadKey={activeTableLoadKey}
            isProfileLocked={isProfileLocked}
          />

          {truncateTarget && (
            <TruncateTableDialog
              open={true}
              tableName={truncateTarget.name}
              onClose={closeTruncate}
              onConfirm={confirmTruncate}
            />
          )}

          {showSaveDialog && (
            <SaveChangesDialog
              open={showSaveDialog}
              onClose={() => setShowSaveDialog(false)}
              onConfirm={async () => {
                saveErrorsRef.current = [];
                let thrown: unknown = null;
                try {
                  await actions.saveChanges();
                } catch (error) {
                  thrown = error;
                }
                // saveChanges settles only after every job, so nothing
                // reports after this point.
                const messages = saveFailureMessages(
                  saveErrorsRef.current ?? [],
                  thrown
                );
                saveErrorsRef.current = null;
                // Keep the review open with what failed; it still lists
                // whatever is unsaved.
                if (messages.length) throw new Error(messages.join("\n"));
                setShowSaveDialog(false);
              }}
              targetLabel={saveTargetLabel}
              patchMap={patchMap}
              engine={engine ?? "postgres"}
              newTableSql={newTableSql}
              objectSql={objectSql}
              objectChangeSummary={objectChangeSummary}
              objectNotices={objectSaveNotices}
              activeScreen={activeProfileScreen}
              getRowAt={useConnectionStore.getState().getRowAt}
              getOriginalRowAt={useConnectionStore.getState().getOriginalRowAt}
              offset={currentOffset}
            />
          )}
        </div>

        <DatabaseSearchDialog
          open={searchDialogOpen}
          onClose={() => setSearchDialogOpen(false)}
          tables={meta.tables ?? []}
          schemas={meta.schemas ?? []}
          objects={meta.objects ?? []}
          snippets={visibleSearchSnippets}
          schemaLabel={
            engine === "mongo" || engine === "redis" ? "Database" : "Schema"
          }
          onSelectTable={(table) => void actions.selectTable(table)}
          onSelectSchema={onSchemaChange}
          onSelectObject={(object) => {
            openDatabaseObjectsManager({
              kind: object.kind,
              object,
            });
          }}
          onSelectSnippet={(snippet) => {
            void insertSnippetSql(snippet.sql);
          }}
        />

        <SnippetPickerDialog
          open={snippetPickerOpen}
          onClose={() => setSnippetPickerOpen(false)}
          profileId={connectionProfileId}
          onInsert={insertSnippetSql}
          onCreate={() => {
            setSnippetEditorInitial(undefined);
            setSnippetEditorOpen(true);
          }}
          onEdit={(snippet) => {
            setSnippetEditorInitial(snippet);
            setSnippetEditorOpen(true);
          }}
        />

        <SnippetEditorDialog
          open={snippetEditorOpen}
          onClose={() => {
            setSnippetEditorOpen(false);
            setSnippetEditorInitial(undefined);
          }}
          onSaved={() => setSnippetPickerOpen(true)}
          profileId={connectionProfileId}
          initial={snippetEditorInitial}
        />

        <DbHealthInspectorDialog
          open={healthInspectorOpen}
          onClose={() => setHealthInspectorOpen(false)}
          engine={engine}
          runtimeConnectionId={runtimeConnectionId}
          profileId={connectionProfileId}
          tabId={activeProfileScreen}
          databaseLabel={diagramDatabase}
        />

        <StandaloneTableExportHost
          profileScreenId={activeProfileScreen}
          runtimeConnectionId={runtimeConnectionId}
          engine={engine}
          target={standaloneExportTarget}
          onClearTarget={clearStandaloneExportTarget}
        />

        <StandaloneSqlDumpImportHost
          profileScreenId={activeProfileScreen}
          target={standaloneDumpTarget}
          onClearTarget={clearStandaloneDumpTarget}
        />

        <StandaloneTableImportHost
          profileScreenId={activeProfileScreen}
          runtimeConnectionId={runtimeConnectionId}
          engine={engine}
          target={standaloneImportTarget}
          onClearTarget={clearStandaloneImportTarget}
          onImported={(screenTabId, t) =>
            // Only the originating tab's cached rows; no edits discarded.
            forgetImportedTableRows(screenTabId, {
              schema: t.schema,
              name: t.tableName,
            })
          }
        />

        <DiagramGeneratorDialog
          open={diagramOpen}
          onClose={() => setDiagramOpen(false)}
          engine={engine}
          database={diagramDatabase}
          schema={activeSchema}
          connectionId={runtimeConnectionId}
          tabId={activeProfileScreen}
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
