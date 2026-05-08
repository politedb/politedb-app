import { useCallback, useRef } from "preact/hooks";

import type {
  DatabaseEngine,
  OpenWindow,
  TableItem,
  TableWindow,
} from "src/types";
import { connectionRemove } from "src/lib/tauri";
import {
  mongoDeleteDocuments,
  mongoInsertDocuments,
  mongoUpdateDocuments,
} from "src/lib/tauri/mongo";
import { runRedisCommand } from "src/lib/tauri/redis";
import type { LoadFlags, TablePagination } from "src/hooks/useLoadTableData";
import { tableKey } from "src/hooks/useLoadTableData";
import { generateSqlFromPatches, type PatchMap } from "src/utils/generateSql";
import { normalizeSqlError } from "src/lib/tauri/queryValidate";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import {
  type DataAction,
  type DataKey,
  useConnectionStore,
} from "src/stores/connection";
import { type ProfileTab, useScreenStore } from "src/stores/screen";
import { RunSqlReturn } from "./useSqlHistoryRunner";
import { createTableQuery } from "src/hooks/queries";

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

  setWarningRefresh: (v: boolean) => void;
  setPendingCloseTabId: (v: string | null) => void;
  setError: (v: string | null) => void;
  setShowSaveDialog: (v: boolean) => void;

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

type WindowPatchBuckets = Partial<
  Record<DataAction, Partial<Record<DataKey, Record<string, unknown>>>>
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
    closeWindow: closeWindowFn,
    removeTab,
    setActiveProfileScreen,
    newTableSaveRef,
    refreshRuntimeConnection,
  } = args;

  const mongoCellToValue = useCallback((cell: unknown): unknown => {
    if (cell == null) return null;
    if (typeof cell !== "object") return cell;

    const c = cell as { t?: string; v?: unknown };
    switch (c.t) {
      case "Null":
        return null;
      case "Str":
      case "Json":
      case "BytesB64":
      case "I64":
      case "F64":
      case "Bool":
        return c.v ?? null;
      default:
        if ("v" in c) return c.v ?? null;
        return cell;
    }
  }, []);

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
  }, [engine, openSqlEditor]);

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
    },
    [setLimit, setOffset]
  );

  const refresh = useCallback(async () => {
    if (!runtimeConnectionId) {
      await refreshRuntimeConnection();
    }

    const tabDirty = tabHasChanges(activeProfileScreen);
    if (tabDirty) {
      setWarningRefresh(true);
      return;
    }

    await refreshSchemaAndTables();

    const tableWindows = getOpenTableWindows(openWindows, activeProfileScreen);
    if (tableWindows.length === 0) return;

    await Promise.all(
      tableWindows.map((window) =>
        loadTableData(
          window.table.schema,
          window.table.name,
          { limit, offset },
          { force: true, forceRefresh: true }
        )
      )
    );
  }, [
    tabHasChanges,
    activeProfileScreen,
    setWarningRefresh,
    refreshSchemaAndTables,
    openWindows,
    loadTableData,
    limit,
    offset,
    refreshRuntimeConnection,
    runtimeConnectionId,
  ]);

  const getNewTableSql = useCallback(() => {
    if (!activeTableWindow) return { data: [], error: null };

    const s = useConnectionStore.getState();

    // Check for new table data
    const newTableData =
      s.newTableData[activeProfileScreen]?.[activeTableWindow.id];

    if (!newTableData) return { data: [], error: null };

    const { tableName, columns, primaryKey } = newTableData;
    const validColumns = columns.filter((col) => col.column_name?.trim());

    if (!tableName?.trim() || validColumns.length === 0) {
      return { data: [], error: "Invalid new table data" };
    }

    const sql = createTableQuery(
      activeTableWindow.table.schema,
      tableName.trim(),
      validColumns,
      primaryKey,
      engine
    );

    return { data: [sql], error: null };
  }, [activeProfileScreen, activeTableWindow]);

  const getPatchMap = useCallback((): PatchMap | null => {
    if (!activeTableWindow) return null;

    const s = useConnectionStore.getState();
    const tabPatchMap = (s.dataPatchMap[activeProfileScreen] ??
      {}) as unknown as PatchMap;

    const entry = (tabPatchMap as unknown as Record<string, unknown>)[
      activeTableWindow.id
    ] as PatchMapEntry | undefined;

    if (!entry) return null;

    return { [activeTableWindow.id]: entry } as unknown as PatchMap;
  }, [activeProfileScreen, activeTableWindow]);

  const syncTableMeta = useCallback(
    (targetTableName?: string) => {
      if (!activeTableWindow) return;

      const s = useConnectionStore.getState();
      const tableNameToUse = targetTableName ?? activeTableWindow.table.name;

      const key = tableKey(
        activeProfileScreen,
        activeTableWindow.table.schema,
        tableNameToUse
      );
      const fresh = s.tableDataMap[key];
      if (fresh) {
        if (Array.isArray(fresh.structure)) {
          s.setTableStructure(
            activeProfileScreen,
            activeTableWindow.id,
            fresh.structure
          );
        }
        if (Array.isArray(fresh.constraints)) {
          s.setTableConstraints(
            activeProfileScreen,
            activeTableWindow.id,
            fresh.constraints
          );
        }
      }
    },
    [activeProfileScreen, activeTableWindow]
  );

  const applyPatchesForActiveWindow = useCallback(async () => {
    if (isActiveTabLocked) return;
    if (!activeTableWindow || !runtimeConnectionId) return;

    try {
      const onlyActive = getPatchMap();

      if (!onlyActive) return;

      const entry = onlyActive[activeTableWindow.id];

      if (engine === "mongo") {
        const patches = entry?.patches;
        const createData = patches?.create?.data ?? {};
        const updateData = patches?.update?.data ?? {};
        const deleteData = patches?.delete?.data ?? {};

        const hasUnsupportedPatches =
          Object.keys(patches?.create?.structure ?? {}).length > 0 ||
          Object.keys(patches?.update?.structure ?? {}).length > 0 ||
          Object.keys(patches?.delete?.structure ?? {}).length > 0 ||
          Object.keys(patches?.create?.constraints ?? {}).length > 0 ||
          Object.keys(patches?.update?.constraints ?? {}).length > 0 ||
          Object.keys(patches?.delete?.constraints ?? {}).length > 0;

        if (hasUnsupportedPatches) {
          throw new Error(
            "Mongo does not support structure/constraint patches in table view."
          );
        }

        const store = useConnectionStore.getState();
        const key = tableKey(
          activeProfileScreen,
          activeTableWindow.table.schema,
          activeTableWindow.table.name
        );
        const cols = store.tableDataMap[key]?.columns ?? [];
        const idColIdx = cols.findIndex((c) => c.name === "_id");
        if (idColIdx < 0) {
          throw new Error("MONGO_ID_COLUMN_NOT_FOUND");
        }
        const cache = store.tableRowCacheByKey[key];

        const documents = Object.values(createData).map((patch) => {
          const raw = (patch ?? {}) as Record<string, unknown>;
          const doc: Record<string, unknown> = {};

          for (const [k, v] of Object.entries(raw)) {
            if (k === "__rowKey") continue;
            if (k === "_id" && (v === null || String(v ?? "").trim() === "")) {
              continue;
            }
            doc[k] = v;
          }

          return doc;
        });

        const updates = Object.entries(updateData)
          .map(([rowKey, patch]) => {
            const rowIndex = Number(rowKey);
            if (!Number.isFinite(rowIndex) || rowIndex < 0) return null;

            const raw = (patch ?? {}) as Record<string, unknown>;
            if ("_id" in raw) {
              throw new Error("Mongo _id is immutable and cannot be updated.");
            }

            const candidateIndices = [rowIndex, rowIndex + offset];
            const resolvedIndex =
              candidateIndices.find(
                (idx) =>
                  Boolean(cache?.map.get(idx)) ||
                  Boolean(store.getRowAt(key, idx))
              ) ?? rowIndex;

            const originalRow = cache?.map.get(resolvedIndex);
            const fallbackRow = store.getRowAt(key, resolvedIndex);
            const sourceRow = Array.isArray(originalRow)
              ? originalRow
              : fallbackRow;
            if (!sourceRow || !Array.isArray(sourceRow)) return null;

            const idValue = mongoCellToValue(sourceRow[idColIdx]);
            if (idValue == null || String(idValue).trim() === "") {
              return null;
            }

            const set: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(raw)) {
              if (k === "__rowKey" || k === "_id") continue;
              set[k] = v;
            }

            if (Object.keys(set).length === 0) return null;
            return { id: idValue, set };
          })
          .filter(Boolean) as Array<{
          id: unknown;
          set: Record<string, unknown>;
        }>;

        const deleteIds = Object.keys(deleteData)
          .map((rowKey) => {
            const rowIndex = Number(rowKey);
            if (!Number.isFinite(rowIndex) || rowIndex < 0) return null;

            const candidateIndices = [rowIndex, rowIndex + offset];
            const resolvedIndex =
              candidateIndices.find(
                (idx) =>
                  Boolean(cache?.map.get(idx)) ||
                  Boolean(store.getRowAt(key, idx))
              ) ?? rowIndex;

            const originalRow = cache?.map.get(resolvedIndex);
            const fallbackRow = store.getRowAt(key, resolvedIndex);
            const sourceRow = Array.isArray(originalRow)
              ? originalRow
              : fallbackRow;
            if (!sourceRow || !Array.isArray(sourceRow)) return null;

            const idValue = mongoCellToValue(sourceRow[idColIdx]);
            if (idValue == null || String(idValue).trim() === "") {
              return null;
            }
            return idValue;
          })
          .filter((v) => v !== null) as unknown[];

        if (documents.length > 0) {
          await mongoInsertDocuments({
            connectionId: runtimeConnectionId,
            database: activeTableWindow.table.schema,
            collection: activeTableWindow.table.name,
            documents,
          });
        }
        if (updates.length > 0) {
          await mongoUpdateDocuments({
            connectionId: runtimeConnectionId,
            database: activeTableWindow.table.schema,
            collection: activeTableWindow.table.name,
            updates,
          });
        }
        if (deleteIds.length > 0) {
          await mongoDeleteDocuments({
            connectionId: runtimeConnectionId,
            database: activeTableWindow.table.schema,
            collection: activeTableWindow.table.name,
            ids: deleteIds,
          });
        }

        clearChanges(activeProfileScreen, activeTableWindow.id);
        await loadTableData(
          activeTableWindow.table.schema,
          activeTableWindow.table.name,
          { limit, offset },
          {
            force: true,
            refreshRows: true,
            refreshMeta: true,
            refreshStats: true,
          }
        );
        return;
      }

      if (engine === "redis") {
        const patches = entry?.patches;
        const createData = patches?.create?.data ?? {};
        const updateData = patches?.update?.data ?? {};
        const deleteData = patches?.delete?.data ?? {};

        const hasUnsupportedPatches =
          Object.keys(createData).length > 0 ||
          Object.keys(deleteData).length > 0 ||
          Object.keys(patches?.create?.structure ?? {}).length > 0 ||
          Object.keys(patches?.update?.structure ?? {}).length > 0 ||
          Object.keys(patches?.delete?.structure ?? {}).length > 0 ||
          Object.keys(patches?.create?.constraints ?? {}).length > 0 ||
          Object.keys(patches?.update?.constraints ?? {}).length > 0 ||
          Object.keys(patches?.delete?.constraints ?? {}).length > 0;

        if (hasUnsupportedPatches) {
          throw new Error(
            "Redis table view currently supports updating existing values only."
          );
        }

        const store = useConnectionStore.getState();
        const key = tableKey(
          activeProfileScreen,
          activeTableWindow.table.schema,
          activeTableWindow.table.name
        );
        const cols = store.tableDataMap[key]?.columns ?? [];
        const cache = store.tableRowCacheByKey[key];
        const rowsByIndex = Object.entries(updateData);

        for (const [rowKey, patch] of rowsByIndex) {
          const rowIndex = Number(rowKey);
          if (!Number.isFinite(rowIndex) || rowIndex < 0) continue;

          const raw = (patch ?? {}) as Record<string, unknown>;
          const candidateIndices = [rowIndex, rowIndex + offset];
          const resolvedIndex =
            candidateIndices.find(
              (idx) =>
                Boolean(cache?.map.get(idx)) ||
                Boolean(store.getRowAt(key, idx))
            ) ?? rowIndex;
          const sourceRow =
            cache?.map.get(resolvedIndex) ?? store.getRowAt(key, resolvedIndex);
          if (!sourceRow || !Array.isArray(sourceRow)) continue;

          if (cols.length === 1 && cols[0]?.name === "value") {
            if (!Object.prototype.hasOwnProperty.call(raw, "value")) continue;
            await runRedisCommand(runtimeConnectionId, "SET", [
              activeTableWindow.table.name,
              String(raw.value ?? ""),
            ]);
            continue;
          }

          if (
            cols.length >= 2 &&
            cols[0]?.name === "field" &&
            cols[1]?.name === "value"
          ) {
            if (!Object.prototype.hasOwnProperty.call(raw, "value")) continue;
            if (Object.prototype.hasOwnProperty.call(raw, "field")) {
              throw new Error(
                "Redis hash fields cannot be renamed from table view."
              );
            }
            const fieldValue = String(sourceRow[0] ?? "");
            await runRedisCommand(runtimeConnectionId, "HSET", [
              activeTableWindow.table.name,
              fieldValue,
              String(raw.value ?? ""),
            ]);
            continue;
          }

          throw new Error("Redis edit is not supported for this key type yet.");
        }

        clearChanges(activeProfileScreen, activeTableWindow.id);
        await loadTableData(
          activeTableWindow.table.schema,
          activeTableWindow.table.name,
          { limit, offset },
          {
            force: true,
            refreshRows: true,
            refreshMeta: true,
            refreshStats: true,
          }
        );
        return;
      }

      const store = useConnectionStore.getState();
      const sql = generateSqlFromPatches(onlyActive, engine ?? "postgres", {
        activeScreen: activeProfileScreen,
        getRowAt: store.getRowAt,
      });
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

      let targetTableName = activeTableWindow.table.name;
      const metadataPatch = entry?.patches?.update?.structure?.["-1"];

      if (
        metadataPatch &&
        typeof metadataPatch.tableName === "string" &&
        metadataPatch.tableName !== activeTableWindow.table.name
      ) {
        targetTableName = metadataPatch.tableName;

        const screenStore = useScreenStore.getState();
        const windows = screenStore.openWindows[activeProfileScreen] ?? [];
        const nextWindows = windows.map((w) => {
          if (w.id === activeTableWindow.id && w.type === "table") {
            return {
              ...w,
              table: { ...w.table, name: targetTableName },
            };
          }
          return w;
        });
        screenStore.replaceWindows(activeProfileScreen, nextWindows);
        await refreshSchemaAndTables();
      }

      await loadTableData(
        activeTableWindow.table.schema,
        targetTableName,
        { limit, offset },
        { force: true, refreshRows, refreshMeta, refreshStats }
      );

      // Sync edited structure/constraints from freshly loaded meta so UI shows new types
      syncTableMeta(targetTableName);
    } catch (e) {
      setError(normalizeSqlError(e));
    }
  }, [
    isActiveTabLocked,
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
    syncTableMeta,
    mongoCellToValue,
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
  }, [isActiveTabLocked, getNewTableSql, getPatchMap, setError]);

  const saveNewTable = useCallback(async () => {
    if (newTableSaveRef.current) {
      await newTableSaveRef.current();
    }
  }, [newTableSaveRef]);

  const saveChanges = useCallback(async () => {
    if (isActiveTabLocked) return;
    if (!activeTableWindow || !runtimeConnectionId) return;

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
    if (tabDirty) jobs.push(applyPatchesForActiveWindow());

    // keep old behavior: only save new table when not in "pending close tab" flow
    if (pendingCloseTabId === null) jobs.push(saveNewTable());

    if (jobs.length) await Promise.all(jobs);
  }, [
    isActiveTabLocked,
    activeTableWindow,
    runtimeConnectionId,
    activeTab,
    tabHasChanges,
    activeProfileScreen,
    applyPatchesForActiveWindow,
    setError,
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

  const closeNewWindows = useCallback(
    async (tabId: string) => {
      const windows = openWindows[tabId] ?? [];
      if (!windows.length) return;

      await Promise.all(
        windows.map(async (w) => {
          if (w.type === "table" && w.table.new) {
            await closeWindow(w.id, new MouseEvent("click"));
          }
        })
      );
    },
    [openWindows, closeWindow]
  );

  const discardChanges = useCallback(async () => {
    if (pendingCloseTabId) {
      clearChanges(pendingCloseTabId);
      await closeTab(pendingCloseTabId, true);
    } else {
      clearChanges(activeProfileScreen);
      await closeNewWindows(activeProfileScreen);
    }

    setWarningRefresh(false);
    setPendingCloseTabId(null);

    if (!activeTableWindow) return;

    // 🔥 Reload table data after discard so rows are restored from DB
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
    pendingCloseTabId,
    clearChanges,
    closeTab,
    activeProfileScreen,
    setWarningRefresh,
    setPendingCloseTabId,
    activeTableWindow,
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
