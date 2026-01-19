import { useCallback, useRef } from "preact/hooks";

import type {
  DatabaseEngine,
  OpenWindow,
  TableItem,
  TableWindow,
} from "src/types";
import type { QueryResult } from "src/lib/tauri";
import { connectionRemove } from "src/lib/tauri";
import type { LoadFlags, TablePagination } from "src/hooks/useLoadTableData";
import { tableKey } from "src/hooks/useLoadTableData";
import { generateSqlFromPatches, type PatchMap } from "src/utils/generateSql";
import { normalizeSqlError } from "src/utils/queryValidate";
import { useConnectionStore } from "src/stores/connection";
import type { ProfileTab } from "src/stores/screen";

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
}) => Promise<QueryResult>;

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

  setWarningRefresh: (v: boolean) => void;
  setPendingCloseTabId: (v: string | null) => void;
  setError: (v: string | null) => void;

  pendingCloseTabId: string | null;

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
  saveChanges: () => Promise<void>;
  discardChanges: () => Promise<void>;
};

/* =============================================================================
 * Helpers (no any)
 * ============================================================================= */

type RefreshFlags = {
  refreshRows: boolean;
  refreshMeta: boolean;
  refreshStats: boolean;
};

type WindowPatchBuckets = Partial<
  Record<
    "create" | "update" | "delete",
    Partial<
      Record<"data" | "structure" | "constraints", Record<string, unknown>>
    >
  >
>;

type PatchMapEntry = {
  tableWindow: TableWindow;
  patches: WindowPatchBuckets;
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

type NewTableLike = {
  tableName: string;
  columns: Array<{ column_name: string }>;
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

/* =============================================================================
 * Hook
 * ============================================================================= */

export function useConnectionActions(
  args: UseConnectionActionsArgs
): ConnectionActions {
  const closingRef = useRef(false);

  const {
    activeProfileScreen,
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
    closeWindow: closeWindowFn,
    removeTab,
    setActiveProfileScreen,
    newTableSaveRef,
  } = args;

  const clearChanges = useCallback((tabId: string, tableWindowId?: string) => {
    const s = useConnectionStore.getState();
    s.clearTableConstraints(tabId, tableWindowId);
    s.clearTableStructure(tabId, tableWindowId);
    s.clearDataPatchMap(tabId, tableWindowId);
    s.clearNewTableData(tabId, tableWindowId);
  }, []);

  const tabHasChanges = useCallback((tabId: string): boolean => {
    const s = useConnectionStore.getState();

    const derived = (
      s as unknown as {
        dirtyStateByScreen?: Record<string, { hasAnyChanges: boolean }>;
      }
    ).dirtyStateByScreen?.[tabId]?.hasAnyChanges;

    if (typeof derived === "boolean") return derived;

    const pm = s.dataPatchMap[tabId] as unknown as PatchMap | undefined;
    if (patchMapHasAnyChanges(pm)) return true;

    const nt = s.newTableData[tabId] as unknown as
      | Record<string, unknown>
      | undefined;
    if (!nt) return false;

    for (const winId of Object.keys(nt)) {
      if (isValidNewTable(nt[winId])) return true;
    }
    return false;
  }, []);

  const openSql = useCallback(() => {
    openSqlEditor();
  }, [openSqlEditor]);

  const selectTable = useCallback(
    async (table: TableItem) => {
      await openTable(table);
    },
    [openTable]
  );

  const closeWindow = useCallback(
    async (windowId: string, e: MouseEvent) => {
      await closeWindowFn(windowId, e);
    },
    [closeWindowFn]
  );

  const pageChange = useCallback(
    async (nextLimit: number, nextOffset: number) => {
      setLimit(nextLimit);
      setOffset(nextOffset);

      if (!activeTableWindow) return;

      await loadTableData(
        activeTableWindow.table.schema,
        activeTableWindow.table.name,
        { limit: nextLimit, offset: nextOffset }
      );
    },
    [setLimit, setOffset, activeTableWindow, loadTableData]
  );

  const refresh = useCallback(async () => {
    const tabDirty = tabHasChanges(activeProfileScreen);
    if (tabDirty) {
      setWarningRefresh(true);
      return;
    }

    await refreshSchemaAndTables();

    if (!activeTableWindow) return;

    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        force: true,
        refreshRows: true,
        refreshMeta: false,
        refreshStats: false,
      }
    );
  }, [
    tabHasChanges,
    activeProfileScreen,
    setWarningRefresh,
    refreshSchemaAndTables,
    activeTableWindow,
    loadTableData,
    limit,
    offset,
  ]);

  const applyPatchesForActiveWindow = useCallback(async () => {
    if (!activeTableWindow || !runtimeConnectionId) return;

    try {
      const s = useConnectionStore.getState();
      const tabPatchMap = (s.dataPatchMap[activeProfileScreen] ??
        {}) as unknown as PatchMap;

      const entry = (tabPatchMap as unknown as Record<string, unknown>)[
        activeTableWindow.id
      ] as PatchMapEntry | undefined;

      const onlyActive: PatchMap = entry
        ? ({ [activeTableWindow.id]: entry } as unknown as PatchMap)
        : ({} as PatchMap);

      const sql = generateSqlFromPatches(onlyActive, engine ?? "postgres");
      if (!sql.length) {
        setError("An error occurred while applying patches.");
        return;
      }

      for (const stmt of sql) {
        await runSqlWithHistory({
          connectionId: runtimeConnectionId,
          sql: stmt,
        });
      }

      clearChanges(activeProfileScreen, activeTableWindow.id);

      const { refreshRows, refreshMeta, refreshStats } =
        inferRefreshFlagsFromEntry(entry);

      await loadTableData(
        activeTableWindow.table.schema,
        activeTableWindow.table.name,
        { limit, offset },
        { force: true, refreshRows, refreshMeta, refreshStats }
      );
    } catch (e) {
      setError(normalizeSqlError(e));
    }
  }, [
    activeTableWindow,
    runtimeConnectionId,
    activeProfileScreen,
    engine,
    runSqlWithHistory,
    clearChanges,
    loadTableData,
    limit,
    offset,
    setError,
  ]);

  const saveNewTable = useCallback(async () => {
    if (newTableSaveRef.current) {
      await newTableSaveRef.current();
    }
  }, [newTableSaveRef]);

  const saveChanges = useCallback(async () => {
    if (!activeTableWindow || !runtimeConnectionId) return;

    const tabDirty = tabHasChanges(activeProfileScreen);

    const jobs: Array<Promise<void>> = [];
    if (tabDirty) jobs.push(applyPatchesForActiveWindow());

    // keep old behavior: only save new table when not in "pending close tab" flow
    if (pendingCloseTabId === null) jobs.push(saveNewTable());

    if (jobs.length) await Promise.all(jobs);
  }, [
    activeTableWindow,
    runtimeConnectionId,
    tabHasChanges,
    activeProfileScreen,
    applyPatchesForActiveWindow,
    pendingCloseTabId,
    saveNewTable,
  ]);

  const closeTab = useCallback(
    async (tabId: string, skipCheck = false) => {
      if (closingRef.current) return;
      closingRef.current = true;

      try {
        if (!skipCheck && tabHasChanges(tabId)) {
          setPendingCloseTabId(tabId);
          setWarningRefresh(true);
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
      setPendingCloseTabId,
      setWarningRefresh,
      clearChanges,
      profileTabs,
      removeTab,
      activeProfileScreen,
      setActiveProfileScreen,
      openWindows,
      removeTableData,
    ]
  );

  const discardChanges = useCallback(async () => {
    if (pendingCloseTabId) {
      clearChanges(pendingCloseTabId);
      await closeTab(pendingCloseTabId, true);
    } else {
      clearChanges(activeProfileScreen);
    }

    setWarningRefresh(false);
    setPendingCloseTabId(null);
  }, [
    pendingCloseTabId,
    clearChanges,
    closeTab,
    activeProfileScreen,
    setWarningRefresh,
    setPendingCloseTabId,
  ]);

  return {
    openSql,
    selectTable,
    closeWindow,
    closeTab,
    refresh,
    pageChange,
    saveChanges,
    discardChanges,
  };
}
