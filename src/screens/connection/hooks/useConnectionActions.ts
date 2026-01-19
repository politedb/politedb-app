import { useCallback, useRef } from "preact/hooks";

import type {
  DatabaseEngine,
  OpenWindow,
  TableItem,
  TableWindow,
} from "src/types";
import type { QueryResult } from "src/lib/tauri";
import { connectionRemove } from "src/lib/tauri";
import { tableKey } from "src/hooks/useLoadTableData";
import { generateSqlFromPatches, type PatchMap } from "src/utils/generateSql";
import { normalizeSqlError } from "src/utils/queryValidate";
import { useConnectionStore } from "src/stores/connection";

/* =============================================================================
 * Types
 * ============================================================================= */

export type Ref<T> = { current: T };

export type Pagination = {
  limit: number;
  offset: number;
};

export type LoadTableDataFn = (
  schema: string,
  name: string,
  opts: Pagination
) => Promise<void>;

export type RemoveTableDataFn = (schema: string, name: string) => void;

export type RefreshSchemaAndTablesFn = () => Promise<void>;

export type RunSqlWithHistoryFn = (args: {
  connectionId: string;
  sql: string;
}) => Promise<QueryResult>;

export type ConnectionTab = {
  id: string;
  label: string;
  profileId?: string;
  engine?: DatabaseEngine;
  runtimeConnectionId?: string;
};

export type UseConnectionActionsArgs = {
  activeProfileScreen: string; // tabId
  activeId: string | null; // windowId

  activeTab: ConnectionTab | null;
  profileTabs: ConnectionTab[];
  openWindows: Record<string, OpenWindow[]>; // tabId -> windows
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

  for (const winId of Object.keys(patchMap as Record<string, unknown>)) {
    const win = (patchMap as Record<string, unknown>)[winId] as
      | Record<string, unknown>
      | undefined;
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
        if (!rows) continue;

        if (Object.keys(rows).length > 0) return true;
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

  const clearChanges = useCallback((tabId: string, tableWindowId?: string) => {
    const s = useConnectionStore.getState();
    s.clearTableConstraints(tabId, tableWindowId);
    s.clearTableStructure(tabId, tableWindowId);
    s.clearDataPatchMap(tabId, tableWindowId);
    s.clearNewTableData(tabId, tableWindowId);
  }, []);

  const tabHasChanges = useCallback((tabId: string): boolean => {
    const s = useConnectionStore.getState();

    // Fast path if you already have derived dirty state
    const derived = (
      s as unknown as {
        dirtyStateByScreen?: Record<string, { hasAnyChanges: boolean }>;
      }
    ).dirtyStateByScreen?.[tabId]?.hasAnyChanges;
    if (typeof derived === "boolean") return derived;

    // Fallback: scan patchMap + newTableData
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
    args.openSqlEditor();
  }, [args.openSqlEditor]);

  const selectTable = useCallback(
    async (table: TableItem) => {
      await args.openTable(table);
    },
    [args.openTable]
  );

  const closeWindow = useCallback(
    async (windowId: string, e: MouseEvent) => {
      await args.closeWindow(windowId, e);
    },
    [args.closeWindow]
  );

  const pageChange = useCallback(
    async (limit: number, offset: number) => {
      args.setLimit(limit);
      args.setOffset(offset);

      if (!args.activeTableWindow) return;

      await args.loadTableData(
        args.activeTableWindow.table.schema,
        args.activeTableWindow.table.name,
        { limit, offset }
      );
    },
    [args]
  );

  const refresh = useCallback(async () => {
    // block refresh if current tab has patches (same behavior as old code)
    const tabDirty = tabHasChanges(args.activeProfileScreen);
    if (tabDirty) {
      args.setWarningRefresh(true);
      return;
    }

    await args.refreshSchemaAndTables();

    if (!args.activeTableWindow) return;

    await args.loadTableData(
      args.activeTableWindow.table.schema,
      args.activeTableWindow.table.name,
      { limit: args.limit, offset: args.offset }
    );
  }, [args, tabHasChanges]);

  const applyPatchesForActiveWindow = useCallback(async () => {
    if (!args.activeTableWindow || !args.runtimeConnectionId) return;

    try {
      const s = useConnectionStore.getState();
      const tabPatchMap = (s.dataPatchMap[args.activeProfileScreen] ??
        {}) as unknown as PatchMap;

      // Only apply current window’s patches (faster, TablePlus-like)
      const entry = (tabPatchMap as Record<string, unknown>)[
        args.activeTableWindow.id
      ];
      const onlyActive: PatchMap = entry
        ? ({ [args.activeTableWindow.id]: entry } as unknown as PatchMap)
        : ({} as PatchMap);

      const sql = generateSqlFromPatches(onlyActive, args.engine ?? "postgres");
      if (!sql.length) {
        args.setError("An error occurred while applying patches.");
        return;
      }

      for (const stmt of sql) {
        await args.runSqlWithHistory({
          connectionId: args.runtimeConnectionId,
          sql: stmt,
        });
      }

      clearChanges(args.activeProfileScreen, args.activeTableWindow.id);

      await args.loadTableData(
        args.activeTableWindow.table.schema,
        args.activeTableWindow.table.name,
        { limit: args.limit, offset: args.offset }
      );
    } catch (e) {
      args.setError(normalizeSqlError(e));
    }
  }, [args, clearChanges]);

  const saveNewTable = useCallback(async () => {
    if (args.newTableSaveRef.current) {
      await args.newTableSaveRef.current();
    }
  }, [args.newTableSaveRef]);

  const saveChanges = useCallback(async () => {
    if (!args.activeTableWindow || !args.runtimeConnectionId) return;

    const tabDirty = tabHasChanges(args.activeProfileScreen);
    const jobs: Array<Promise<void>> = [];

    if (tabDirty) jobs.push(applyPatchesForActiveWindow());
    if (args.pendingCloseTabId === null) {
      // normal save: allow new table save if present
      // (if you want more strict condition, pass hasNewTableData into args and use it here)
      jobs.push(saveNewTable());
    }

    // If newTableSaveRef is null, saveNewTable does nothing.
    // If no jobs, nothing to do.
    if (jobs.length) await Promise.all(jobs);
  }, [args, tabHasChanges, applyPatchesForActiveWindow, saveNewTable]);

  const closeTab = useCallback(
    async (tabId: string, skipCheck = false) => {
      if (closingRef.current) return;
      closingRef.current = true;

      try {
        if (!skipCheck && tabHasChanges(tabId)) {
          args.setPendingCloseTabId(tabId);
          args.setWarningRefresh(true);
          return;
        }

        clearChanges(tabId);

        const currentTab = args.profileTabs.find((t) => t.id === tabId);
        const newTabs = args.profileTabs.filter((t) => t.id !== tabId);

        args.removeTab(tabId);

        if (args.activeProfileScreen === tabId) {
          args.setActiveProfileScreen(
            newTabs.length ? newTabs[newTabs.length - 1].id : "main"
          );
        }

        if (currentTab?.runtimeConnectionId) {
          try {
            await connectionRemove(currentTab.runtimeConnectionId);
          } catch {
            // ignore
          }
        }

        const windows = args.openWindows[tabId] ?? [];
        if (!windows.length) return;

        const tableWindows = windows.filter((w) => w.type === "table");

        const s = useConnectionStore.getState();

        await Promise.all(
          tableWindows.map(async (w) => {
            const { schema, name } = w.table;
            const k = tableKey(tabId, schema, name);
            const connId = s.tableDataMap[k]?.connectionId ?? null;

            args.removeTableData(schema, name);

            if (connId) {
              try {
                await connectionRemove(connId);
              } catch {
                // ignore
              }
            }
          })
        );
      } finally {
        closingRef.current = false;
      }
    },
    [args, tabHasChanges, clearChanges]
  );

  const discardChanges = useCallback(async () => {
    if (args.pendingCloseTabId) {
      clearChanges(args.pendingCloseTabId);
      await closeTab(args.pendingCloseTabId, true);
    } else {
      clearChanges(args.activeProfileScreen);
    }

    args.setWarningRefresh(false);
    args.setPendingCloseTabId(null);
  }, [args, clearChanges, closeTab]);

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
