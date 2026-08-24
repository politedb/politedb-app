import { useCallback, useRef } from "preact/hooks";

import type {
  DatabaseEngine,
  OpenWindow,
  TableItem,
  TableWindow,
} from "src/types";
import { connectionRemove, operationExecuteTransaction } from "src/lib/tauri";
import { runRedisCommand } from "src/lib/tauri/redis";
import { tableKey } from "src/lib/table-data";
import type { LoadFlags, TablePagination } from "src/lib/table-data";
import {
  applyNonSqlPatchEntry,
  isNonSqlPatchEngine,
  type PatchMapEntry,
} from "src/lib/patches";
import {
  clearTablePagination,
  setTablePagination,
} from "src/screens/connection/tablePagination";
import {
  analyzePatchIdentitySafety,
  generateSqlFromPatches,
  type PatchMap,
} from "src/utils/generateSql";
import { runSqlTransaction } from "src/utils/sqlTransaction";
import { sqlForDisplay } from "src/utils/sqlDialect";
import { normalizeSqlError } from "src/lib/tauri/queryValidate";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import {
  type NewTableDataState,
  useConnectionStore,
} from "src/stores/connection";
import { type ProfileTab, useScreenStore } from "src/stores/screen";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";
import { connectionTabHasChanges } from "src/screens/connection/tabDirty";
import { RunSqlReturn } from "./useSqlHistoryRunner";
import { createTableQuery } from "src/lib/queries/sql";

/* =============================================================================
 * Types
 * ============================================================================= */

export type Ref<T> = { current: T };

export type LoadTableDataFn = (
  schema: string,
  name: string,
  opts?: TablePagination,
  flags?: LoadFlags
) => Promise<void>;

export type RemoveTableDataFn = (schema: string, name: string) => void;

export type RefreshSchemaAndTablesFn = () => Promise<void>;

export type RunSqlWithHistoryFn = (args: {
  connectionId: string;
  sql: string;
}) => Promise<RunSqlReturn>;

export type UseConnectionActionsArgs = {
  activeProfileScreen: string; // tabId
  activeId: string | null; // windowId

  activeTab: ProfileTab | null;
  profileTabs: ProfileTab[];
  openWindows: Record<string, OpenWindow[]>;
  activeTableWindow: TableWindow | undefined;

  runtimeConnectionId: string | undefined;
  engine: DatabaseEngine | undefined;

  limit: number;
  offset: number;
  setLimit: (n: number) => void;
  setOffset: (n: number) => void;

  refreshRuntimeConnection: () => Promise<string | null | undefined>;

  setError: (v: string | null) => void;
  setShowSaveDialog: (v: boolean) => void;

  loadTableData: LoadTableDataFn;
  removeTableData: RemoveTableDataFn;
  refreshSchemaAndTables: RefreshSchemaAndTablesFn;
  runSqlWithHistory: RunSqlWithHistoryFn;

  openSqlEditor: () => void;
  openTable: (table: TableItem) => Promise<string>;
  closeWindow: (windowId: string, e: MouseEvent) => Promise<void>;

  removeTab: (tabId: string) => void;
  setActiveProfileScreen: (tabId: string) => void;

  newTableSaveRef: Ref<(() => Promise<void>) | null>;
};

export type ConnectionActions = {
  openSql: () => void;
  selectTable: (table: TableItem) => Promise<void>;
  closeWindow: (windowId: string, e: MouseEvent) => Promise<void>;
  closeTab: (tabId: string, skipCheck?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  pageChange: (limit: number, offset: number) => Promise<void>;
  beforeSaveChanges: () => void;
  saveChanges: () => Promise<void>;
  discardChanges: () => Promise<void>;
  getPatchMap: () => PatchMap | null;
  getNewTableSql: () => { data: string[]; error: string | null };
  renameRedisKey: (table: TableItem, nextName: string) => Promise<void>;
  deleteRedisKey: (table: TableItem) => Promise<void>;
};

/* =============================================================================
 * Helpers (no any)
 * ============================================================================= */

type RefreshFlags = {
  refreshRows: boolean;
  refreshMeta: boolean;
  refreshStats: boolean;
};

function hasAnyRows(bucket?: Record<string, unknown>): boolean {
  return (
    !!bucket && typeof bucket === "object" && Object.keys(bucket).length > 0
  );
}

function inferRefreshFlagsFromEntry(
  entry: PatchMapEntry | undefined
): RefreshFlags {
  const patches = entry?.patches;

  const dataCreate = patches?.create?.data;
  const dataUpdate = patches?.update?.data;
  const dataDelete = patches?.delete?.data;

  const structCreate = patches?.create?.structure;
  const structUpdate = patches?.update?.structure;
  const structDelete = patches?.delete?.structure;

  const consCreate = patches?.create?.constraints;
  const consUpdate = patches?.update?.constraints;
  const consDelete = patches?.delete?.constraints;

  const hasData =
    hasAnyRows(dataCreate) || hasAnyRows(dataUpdate) || hasAnyRows(dataDelete);

  const hasStructure =
    hasAnyRows(structCreate) ||
    hasAnyRows(structUpdate) ||
    hasAnyRows(structDelete);

  const hasConstraints =
    hasAnyRows(consCreate) || hasAnyRows(consUpdate) || hasAnyRows(consDelete);

  const hasCreateOrDeleteRows =
    hasAnyRows(dataCreate) || hasAnyRows(dataDelete);

  const refreshMeta = hasStructure || hasConstraints;
  const refreshRows = hasData || refreshMeta;
  const refreshStats = hasCreateOrDeleteRows;

  return { refreshRows, refreshMeta, refreshStats };
}

function getTableReloadQueryFlags(
  tabId: string,
  schema: string,
  tableName: string,
  flags: LoadFlags
): LoadFlags {
  const key = tableKey(tabId, schema, tableName);
  const store = useConnectionStore.getState();
  const filterState = store.tableFilterByKey[key];
  const appliedFilters = filterState?.appliedFilters ?? [];
  const hasAppliedFilters = appliedFilters.some(
    (filter) => filter.enabled && Boolean((filter.column ?? "").trim())
  );

  return {
    ...flags,
    filters: hasAppliedFilters ? appliedFilters : undefined,
    filterCombine: filterState?.appliedFilterCombine ?? "AND",
    sortBy: store.tableSortByKey[key] ?? null,
  };
}

type NewTableLike = {
  tableName: string;
  columns: Array<{ column_name: string }>;
};

type NewTableDraftEntry = {
  window: TableWindow;
  data: NewTableDataState;
  sql: string;
};

function isValidNewTable(v: unknown): v is NewTableLike {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.tableName !== "string") return false;
  if (!Array.isArray(obj.columns)) return false;

  const cols = obj.columns as Array<unknown>;
  const hasAnyCol = cols.some((c) => {
    if (!c || typeof c !== "object") return false;
    const cc = c as Record<string, unknown>;
    return (
      typeof cc.column_name === "string" && cc.column_name.trim().length > 0
    );
  });

  return obj.tableName.trim().length > 0 && hasAnyCol;
}

function getNewTableDraftEntries(args: {
  tabId: string;
  openWindows: Record<string, OpenWindow[]>;
  engine: DatabaseEngine | undefined;
}): { data: NewTableDraftEntry[]; error: string | null } {
  const s = useConnectionStore.getState();
  const drafts = s.newTableData[args.tabId] ?? {};
  const windows = args.openWindows[args.tabId] ?? [];
  const windowsById = new Map(windows.map((w) => [w.id, w]));

  const result: NewTableDraftEntry[] = [];

  for (const [windowId, draft] of Object.entries(drafts)) {
    const window = windowsById.get(windowId);
    if (!window || window.type !== "table" || !window.table.new) continue;

    if (!isValidNewTable(draft)) {
      return { data: [], error: "Invalid new table data" };
    }

    const validColumns = draft.columns.filter((col) => col.column_name?.trim());
    const tableName = draft.tableName.trim();

    result.push({
      window,
      data: { ...draft, tableName, columns: validColumns },
      sql: createTableQuery(
        window.table.schema,
        tableName,
        validColumns,
        draft.primaryKey,
        args.engine
      ),
    });
  }

  return { data: result, error: null };
}

function patchMapHasAnyChanges(patchMap: PatchMap | undefined): boolean {
  if (!patchMap) return false;

  const byWin = patchMap as unknown as Record<string, unknown>;
  for (const winId of Object.keys(byWin)) {
    const win = byWin[winId] as { patches?: unknown } | undefined;
    const patches = win?.patches as Record<string, unknown> | undefined;
    if (!patches) continue;

    for (const action of Object.keys(patches)) {
      const actionPatches = patches[action] as
        | Record<string, unknown>
        | undefined;
      if (!actionPatches) continue;

      for (const dataKey of Object.keys(actionPatches)) {
        const rows = actionPatches[dataKey] as
          | Record<string, unknown>
          | undefined;
        if (rows && Object.keys(rows).length > 0) return true;
      }
    }
  }

  return false;
}

function getTabPatchMap(tabId: string): PatchMap | null {
  const s = useConnectionStore.getState();
  const tabPatchMap = (s.dataPatchMap[tabId] ?? {}) as unknown as PatchMap;
  return patchMapHasAnyChanges(tabPatchMap) ? tabPatchMap : null;
}

function hydratePatchMapWithLatestTableData(
  tabId: string,
  patchMap: PatchMap
): PatchMap {
  const s = useConnectionStore.getState();
  const out: PatchMap = {};

  for (const [windowId, entry] of Object.entries(patchMap)) {
    const key = tableKey(
      tabId,
      entry.tableWindow.table.schema,
      entry.tableWindow.table.name
    );
    const latestTableData = s.tableDataMap[key];
    out[windowId] = {
      ...entry,
      tableData: latestTableData ?? entry.tableData,
    };
  }

  return out;
}

function getOpenTableWindows(
  openWindows: Record<string, OpenWindow[]>,
  profileId: string
): TableWindow[] {
  const windows = openWindows[profileId] ?? [];
  return windows.filter(
    (window): window is TableWindow => window.type === "table"
  );
}

/* =============================================================================
 * Hook
 * ============================================================================= */

export function useConnectionActions(
  args: UseConnectionActionsArgs
): ConnectionActions {
  const closingRef = useRef(false);
  const isActiveTabLocked = !!args.activeTab?.isLocked;

  const {
    activeProfileScreen,
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
    setError,
    setShowSaveDialog,
    loadTableData,
    removeTableData,
    refreshSchemaAndTables,
    runSqlWithHistory,
    openSqlEditor,
    openTable,
    closeWindow: closeWindowFn,
    removeTab,
    setActiveProfileScreen,
    refreshRuntimeConnection,
  } = args;

  const clearChanges = useCallback((tabId: string, tableWindowId?: string) => {
    const s = useConnectionStore.getState();
    s.clearTableConstraints(tabId, tableWindowId);
    s.clearTableStructure(tabId, tableWindowId);
    s.clearDataPatchMap(tabId, tableWindowId);
    s.clearNewTableData(tabId, tableWindowId);
  }, []);

  const clearTablePatchChanges = useCallback(
    (tabId: string, tableWindowId?: string) => {
      const s = useConnectionStore.getState();
      s.clearTableConstraints(tabId, tableWindowId);
      s.clearTableStructure(tabId, tableWindowId);
      s.clearDataPatchMap(tabId, tableWindowId);
    },
    []
  );

  const tabHasChanges = useCallback(
    (tabId: string) => connectionTabHasChanges(tabId),
    []
  );

  const openSql = useCallback(() => {
    openSqlEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, openSqlEditor]);

  const selectTable = useCallback(
    async (table: TableItem) => {
      await openTable(table);
    },
    [openTable]
  );

  const closeWindow = useCallback(
    async (windowId: string, e: MouseEvent) => {
      const window = openWindows[activeProfileScreen]?.find(
        (w) => w.id === windowId
      );
      if (window?.type === "table") {
        clearTablePagination(windowId);
      }
      await closeWindowFn(windowId, e);
    },
    [activeProfileScreen, closeWindowFn, openWindows]
  );

  const pageChange = useCallback(
    async (nextLimit: number, nextOffset: number) => {
      setLimit(nextLimit);
      setOffset(nextOffset);
      if (activeTableWindow) {
        setTablePagination(activeTableWindow.id, {
          limit: nextLimit,
          offset: nextOffset,
        });
      }
    },
    [activeTableWindow, setLimit, setOffset]
  );

  const refresh = useCallback(async () => {
    if (!runtimeConnectionId) {
      await refreshRuntimeConnection();
    }

    const patchMap = getTabPatchMap(activeProfileScreen);
    const tabDirty = !!patchMap || tabHasChanges(activeProfileScreen);
    if (tabDirty) {
      useUnsavedChangesDialogStore.getState().openForRefresh();
      return;
    }

    await refreshSchemaAndTables();

    const tableWindows = getOpenTableWindows(openWindows, activeProfileScreen);
    if (tableWindows.length === 0) return;

    const store = useConnectionStore.getState();
    const uniqueTableWindows = Array.from(
      new Map(
        tableWindows.map((window) => [
          tableKey(activeProfileScreen, window.table.schema, window.table.name),
          window,
        ])
      ).values()
    );

    await Promise.all(
      uniqueTableWindows.map((window) => {
        const key = tableKey(
          activeProfileScreen,
          window.table.schema,
          window.table.name
        );
        const applied = store.tableFilterByKey[key];
        const hasAppliedFilters = Boolean(
          applied?.appliedFilters?.some(
            (filter) => filter.enabled && Boolean((filter.column ?? "").trim())
          )
        );

        return loadTableData(
          window.table.schema,
          window.table.name,
          { limit, offset },
          {
            forceRefresh: true,
            refreshRows: true,
            refreshRowCount: true,
            filters: hasAppliedFilters ? applied.appliedFilters : undefined,
            filterCombine: applied?.appliedFilterCombine ?? "AND",
          }
        );
      })
    );
  }, [
    tabHasChanges,
    activeProfileScreen,
    refreshSchemaAndTables,
    openWindows,
    loadTableData,
    limit,
    offset,
    refreshRuntimeConnection,
    runtimeConnectionId,
  ]);

  const getNewTableSql = useCallback(() => {
    const drafts = getNewTableDraftEntries({
      tabId: activeProfileScreen,
      openWindows,
      engine,
    });

    if (drafts.error) return { data: [], error: drafts.error };

    return { data: drafts.data.map((draft) => draft.sql), error: null };
  }, [activeProfileScreen, openWindows, engine]);

  const getPatchMap = useCallback((): PatchMap | null => {
    const patchMap = getTabPatchMap(activeProfileScreen);
    if (!patchMap) return null;
    return hydratePatchMapWithLatestTableData(activeProfileScreen, patchMap);
  }, [activeProfileScreen]);

  const applyPatchesForCurrentTab = useCallback(async () => {
    if (isActiveTabLocked) return;

    const patchMap = getPatchMap();
    if (!patchMap) return;
    const connectionId =
      runtimeConnectionId ?? (await refreshRuntimeConnection());
    if (!connectionId) {
      setError("No active connection.");
      return;
    }

    try {
      const changedEntries = Object.values(
        patchMap as unknown as Record<string, PatchMapEntry>
      );

      if (isNonSqlPatchEngine(engine)) {
        const patchCtx = {
          activeProfileScreen,
          runtimeConnectionId: connectionId,
          offset,
        };
        for (const entry of changedEntries) {
          await applyNonSqlPatchEntry(engine!, entry, patchCtx);
        }

        clearTablePatchChanges(activeProfileScreen);
        await Promise.all(
          changedEntries.map((entry) =>
            loadTableData(
              entry.tableWindow.table.schema,
              entry.tableWindow.table.name,
              { limit, offset },
              getTableReloadQueryFlags(
                activeProfileScreen,
                entry.tableWindow.table.schema,
                entry.tableWindow.table.name,
                {
                  force: true,
                  refreshRows: true,
                  refreshMeta: true,
                  refreshStats: true,
                }
              )
            )
          )
        );
        return;
      }

      // Ensure relational UPDATE/DELETE generation can detect primary keys even
      // when structure metadata has not been opened in the UI yet.
      await Promise.all(
        changedEntries.map(async (entry) => {
          const constraints = entry.tableData?.constraints;
          if (Array.isArray(constraints) && constraints.length > 0) return;

          await loadTableData(
            entry.tableWindow.table.schema,
            entry.tableWindow.table.name,
            { limit, offset },
            {
              refreshRows: false,
              refreshMeta: true,
              refreshForeignKeys: false,
              refreshStats: false,
            }
          );
        })
      );

      const latestPatchMap = getPatchMap();
      if (!latestPatchMap) return;

      const store = useConnectionStore.getState();
      const safetyIssues = analyzePatchIdentitySafety(
        latestPatchMap,
        engine ?? "postgres"
      );
      store.setVirtualKeySafety(activeProfileScreen, safetyIssues);

      const blockingIssue = safetyIssues.find(
        (issue) => issue.kind === "blocked"
      );
      if (blockingIssue) {
        setError(blockingIssue.message);
        return;
      }

      const sql = generateSqlFromPatches(latestPatchMap, engine ?? "postgres", {
        activeScreen: activeProfileScreen,
        getRowAt: store.getRowAt,
        getOriginalRowAt: store.getOriginalRowAt,
        offset,
      });

      if (!sql.length) {
        setError("An error occurred while applying patches.");
        return;
      }

      await runSqlTransaction({
        engine: engine ?? "postgres",
        statements: sql,
        runBatch: async (statements) => {
          await operationExecuteTransaction({
            connectionId,
            statements,
          });
          for (const statement of statements) {
            useConnectionStore
              .getState()
              .addQueryHistory(
                activeProfileScreen,
                sqlForDisplay(statement, engine ?? undefined)
              );
          }
        },
        run: async (stmt) => {
          await runSqlWithHistory({
            connectionId,
            sql: stmt,
          });
        },
      });

      clearTablePatchChanges(activeProfileScreen);
      useConnectionStore.getState().clearVirtualKeySafety(activeProfileScreen);

      let shouldRefreshSchema = false;
      await Promise.all(
        changedEntries.map(async (entry) => {
          const tableWindow = entry.tableWindow;
          if (!tableWindow) return;

          const metadataPatch = entry.patches?.update?.structure?.["-1"] as
            | { tableName?: unknown }
            | undefined;
          const targetTableName =
            metadataPatch &&
            typeof metadataPatch.tableName === "string" &&
            metadataPatch.tableName !== tableWindow.table.name
              ? metadataPatch.tableName
              : tableWindow.table.name;

          if (targetTableName !== tableWindow.table.name) {
            shouldRefreshSchema = true;
            const screenStore = useScreenStore.getState();
            const windows = screenStore.openWindows[activeProfileScreen] ?? [];
            screenStore.replaceWindows(
              activeProfileScreen,
              windows.map((w) =>
                w.id === tableWindow.id && w.type === "table"
                  ? { ...w, table: { ...w.table, name: targetTableName } }
                  : w
              )
            );
          }

          const { refreshRows, refreshMeta, refreshStats } =
            inferRefreshFlagsFromEntry(entry);
          await loadTableData(
            tableWindow.table.schema,
            targetTableName,
            { limit, offset },
            getTableReloadQueryFlags(
              activeProfileScreen,
              tableWindow.table.schema,
              targetTableName,
              {
                force: true,
                forceRefresh: refreshRows,
                refreshRows,
                refreshMeta,
                refreshStats,
              }
            )
          );
        })
      );

      if (shouldRefreshSchema) {
        await refreshSchemaAndTables();
      }
    } catch (e) {
      setError(normalizeSqlError(e));
    }
  }, [
    isActiveTabLocked,
    getPatchMap,
    runtimeConnectionId,
    refreshRuntimeConnection,
    setError,
    engine,
    activeProfileScreen,
    offset,
    clearTablePatchChanges,
    loadTableData,
    limit,
    runSqlWithHistory,
    refreshSchemaAndTables,
  ]);

  const beforeSaveChanges = useCallback(() => {
    if (isActiveTabLocked) return;
    const newTableSql = getNewTableSql();
    const hasNewTable = !newTableSql.error && newTableSql.data.length > 0;

    const patchMap = getPatchMap();
    const hasPatches = patchMap && Object.keys(patchMap).length > 0;

    if (newTableSql.error) {
      setError(newTableSql.error);
      return;
    }

    if (!hasPatches && !hasNewTable) return;

    setShowSaveDialog(true);
  }, [
    isActiveTabLocked,
    getNewTableSql,
    getPatchMap,
    setShowSaveDialog,
    setError,
  ]);

  const saveNewTables = useCallback(async () => {
    const drafts = getNewTableDraftEntries({
      tabId: activeProfileScreen,
      openWindows,
      engine,
    });

    if (drafts.error) {
      setError(drafts.error);
      return;
    }

    if (!drafts.data.length) return;

    const connectionId =
      runtimeConnectionId ?? (await refreshRuntimeConnection());
    if (!connectionId) {
      setError("No active connection.");
      return;
    }

    const activeNewTableDraft = drafts.data.find(
      (draft) => draft.window.id === activeTableWindow?.id
    );
    const s = useConnectionStore.getState();

    for (const draft of drafts.data) {
      await runSqlWithHistory({
        connectionId,
        sql: draft.sql,
      });

      s.clearNewTableData(activeProfileScreen, draft.window.id);
      useScreenStore
        .getState()
        .removeWindow(activeProfileScreen, draft.window.id);
    }

    await refreshSchemaAndTables();

    if (activeNewTableDraft) {
      await openTable({
        schema: activeNewTableDraft.window.table.schema,
        name: activeNewTableDraft.data.tableName,
      });
    }
  }, [
    activeProfileScreen,
    openWindows,
    engine,
    runtimeConnectionId,
    refreshRuntimeConnection,
    activeTableWindow,
    runSqlWithHistory,
    setError,
    refreshSchemaAndTables,
    openTable,
  ]);

  const saveChanges = useCallback(async () => {
    if (isActiveTabLocked) return;
    const safetyMode =
      activeTab?.querySafetyMode ?? (activeTab?.isLocked ? "lock" : "default");

    if (safetyMode === "safe") {
      try {
        await securityTouchIdAuthenticate(
          "Authenticate with Touch ID before saving changes."
        );
      } catch (e) {
        setError(normalizeSqlError(e));
        return;
      }
    }

    const tabDirty = tabHasChanges(activeProfileScreen);

    const jobs: Array<Promise<void>> = [];
    if (tabDirty) jobs.push(applyPatchesForCurrentTab());

    // keep old behavior: only save new table when not in "pending close tab" flow
    if (useUnsavedChangesDialogStore.getState().pendingCloseTabId === null) {
      jobs.push(saveNewTables());
    }

    if (jobs.length) await Promise.all(jobs);
  }, [
    isActiveTabLocked,
    activeTab,
    tabHasChanges,
    activeProfileScreen,
    applyPatchesForCurrentTab,
    setError,
    saveNewTables,
  ]);

  const closeTab = useCallback(
    async (tabId: string, skipCheck = false) => {
      if (closingRef.current) return;

      closingRef.current = true;

      try {
        if (!skipCheck && tabHasChanges(tabId)) {
          useUnsavedChangesDialogStore.getState().openForTabClose(tabId);
          return;
        }

        clearChanges(tabId);

        const currentTab = profileTabs.find((t) => t.id === tabId);
        const newTabs = profileTabs.filter((t) => t.id !== tabId);

        removeTab(tabId);

        if (activeProfileScreen === tabId) {
          setActiveProfileScreen(
            newTabs.length ? newTabs[newTabs.length - 1].id : "main"
          );
        }

        if (currentTab?.runtimeConnectionId) {
          try {
            await connectionRemove(currentTab.runtimeConnectionId);
          } catch {}
        }

        const windows = openWindows[tabId] ?? [];
        if (!windows.length) return;

        const tableWindows = windows.filter((w) => w.type === "table");
        const s = useConnectionStore.getState();

        await Promise.all(
          tableWindows.map(async (w) => {
            const { schema, name } = w.table;
            const k = tableKey(tabId, schema, name);
            const connId = s.tableDataMap[k]?.connectionId ?? null;

            removeTableData(schema, name);

            if (connId) {
              try {
                await connectionRemove(connId);
              } catch {}
            }
          })
        );
      } finally {
        closingRef.current = false;
      }
    },
    [
      tabHasChanges,
      clearChanges,
      profileTabs,
      removeTab,
      activeProfileScreen,
      setActiveProfileScreen,
      openWindows,
      removeTableData,
    ]
  );

  const closeNewWindows = useCallback(
    async (tabId: string) => {
      const draftWindowIds = new Set(
        Object.keys(useConnectionStore.getState().newTableData[tabId] ?? {})
      );
      const windows = openWindows[tabId] ?? [];
      if (!windows.length) return;

      await Promise.all(
        windows.map(async (w) => {
          if (w.type === "table" && (w.table.new || draftWindowIds.has(w.id))) {
            await closeWindow(w.id, new MouseEvent("click"));
          }
        })
      );
    },
    [openWindows, closeWindow]
  );

  const discardChanges = useCallback(async () => {
    const pendingCloseTabId =
      useUnsavedChangesDialogStore.getState().pendingCloseTabId;

    if (pendingCloseTabId) {
      clearChanges(pendingCloseTabId);
      await closeTab(pendingCloseTabId, true);
    } else {
      await closeNewWindows(activeProfileScreen);
      clearChanges(activeProfileScreen);
    }

    useUnsavedChangesDialogStore.getState().close();

    if (!activeTableWindow) return;

    const activeTableKey = tableKey(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
    const activeTableFilter =
      useConnectionStore.getState().tableFilterByKey[activeTableKey];

    // 🔥 Reload table data after discard so rows are restored from DB
    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        force: true,
        forceRefresh: true,
        refreshRows: true,
        refreshMeta: false,
        refreshStats: false,
        filters:
          activeTableFilter?.appliedFilters &&
          activeTableFilter.appliedFilters.length > 0
            ? activeTableFilter.appliedFilters
            : undefined,
        filterCombine: activeTableFilter?.appliedFilterCombine ?? "AND",
      }
    );
  }, [
    activeTableWindow,
    activeProfileScreen,
    loadTableData,
    limit,
    offset,
    clearChanges,
    closeTab,
    closeNewWindows,
  ]);

  const renameRedisKey = useCallback(
    async (table: TableItem, nextName: string) => {
      if (isActiveTabLocked || engine !== "redis" || !runtimeConnectionId)
        return;
      if (!nextName || nextName === table.name) return;

      try {
        await runRedisCommand(runtimeConnectionId, "RENAME", [
          table.name,
          nextName,
        ]);

        const screenStore = useScreenStore.getState();
        const windows = screenStore.openWindows[activeProfileScreen] ?? [];
        const nextWindows = windows.map((w) => {
          if (w.type === "table" && w.table.name === table.name) {
            return { ...w, table: { ...w.table, name: nextName } };
          }
          return w;
        });
        screenStore.replaceWindows(activeProfileScreen, nextWindows);

        await refreshSchemaAndTables();
        await loadTableData(
          table.schema,
          nextName,
          { limit, offset },
          {
            force: true,
            refreshRows: true,
            refreshMeta: true,
            refreshStats: true,
          }
        );
      } catch (e) {
        setError(normalizeSqlError(e));
      }
    },
    [
      isActiveTabLocked,
      engine,
      runtimeConnectionId,
      activeProfileScreen,
      refreshSchemaAndTables,
      loadTableData,
      limit,
      offset,
      setError,
    ]
  );

  const deleteRedisKey = useCallback(
    async (table: TableItem) => {
      if (isActiveTabLocked || engine !== "redis" || !runtimeConnectionId)
        return;

      try {
        await runRedisCommand(runtimeConnectionId, "DEL", [table.name]);
        const windows =
          useScreenStore.getState().openWindows[activeProfileScreen] ?? [];
        const targetWindow = windows.find(
          (w) => w.type === "table" && w.table.name === table.name
        );
        if (targetWindow) {
          await closeWindowFn(targetWindow.id, new MouseEvent("click"));
        }
        await refreshSchemaAndTables();
      } catch (e) {
        setError(normalizeSqlError(e));
      }
    },
    [
      isActiveTabLocked,
      engine,
      runtimeConnectionId,
      activeProfileScreen,
      closeWindowFn,
      refreshSchemaAndTables,
      setError,
    ]
  );

  return {
    openSql,
    selectTable,
    closeWindow,
    closeTab,
    refresh,
    pageChange,
    beforeSaveChanges,
    saveChanges,
    discardChanges,
    getPatchMap,
    getNewTableSql,
    renameRedisKey,
    deleteRedisKey,
  };
}
