import { useCallback, useMemo, useRef } from "preact/hooks";
import { cellToString } from "src/utils/convert";
import { useScreenStore } from "src/stores/screen";
import { profileConnect } from "src/lib/tauri/profile";
import {
  tableColumnsQuery,
  tableDataQuery,
  tableOidQuery,
  tableConstraintsQuery,
  tableConstraintsMySqlQuery,
  tableForeignKeysQuery,
  tableRowCountQuery,
  tableSizeInfoQuery,
  tableStructuresQuery,
  tableStructuresMySqlQuery,
  type TableFilterCondition,
} from "./queries";
import { runSqlQuery, startSqlQueryStream } from "src/lib/tauri/query";
import { operationBus } from "src/lib/tauri/operationBus";
import { operationCancel, TableChunk } from "src/lib/tauri";
import { DEFAULT_ROWS_CAP, useConnectionStore } from "src/stores/connection";
import type { DatabaseEngine } from "src/types";
import { retryAsync } from "src/utils/common";

// =============================================================================
// Types & Constants
// =============================================================================

export function tableKey(
  activeScreen: string,
  schema: string,
  tableName: string
) {
  return `${activeScreen}.${schema}.${tableName}`;
}

export type TablePagination = { limit: number; offset: number };
export const DEFAULT_LIMIT = 300;
export const DEFAULT_OFFSET = 0;

const RETRY_ATTEMPTS = 8;
const inflightLoadBySignature = new Map<string, Promise<void>>();

const EMPTY_META = {
  columns: null,
  structure: null,
  constraints: null,
  foreignKeys: null,
  sizeInfo: null,
  rowCount: null,
  connectionId: null,
  busy: false,
  error: null,
};

export type LoadFlags = {
  force?: boolean; // Force refresh everything (bypasses dedup check)
  refreshRows?: boolean; // Default true (but first-load always fetches rows)
  refreshMeta?: boolean; // Structure + constraints (default false)
  refreshStats?: boolean; // RowCount + sizeInfo (default false)
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
};

type ColumnRow = { name: string | null; db_type: string | null };

// =============================================================================
// Helpers
// =============================================================================

function isNonEmptyName(v: ColumnRow) {
  return (v.name ?? "").trim().length > 0;
}

function getErrorMessage(e: unknown) {
  if (e && typeof e === "object") {
    const rec = e as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error) return rec.error;
    if (typeof rec.message === "string" && rec.message) return rec.message;
  }
  return String(e ?? "UNKNOWN_ERROR");
}

type LoadPlan = {
  key: string;
  prev: any;

  force: boolean;
  isFirstLoad: boolean;

  needColumns: boolean;
  needRows: boolean;
  needRowCount: boolean;
  needSizeInfo: boolean;
  needMeta: boolean;

  // busy should reflect only meta/columns/stats work, NOT rows streaming
  needAnyMetaWork: boolean;
};

/**
 * Determines what needs to be fetched based on current state and flags.
 */
function computeLoadPlan(params: {
  key: string;
  prev: any;
  flags: LoadFlags;
  pagination?: TablePagination;
}): LoadPlan {
  const { key, prev, flags, pagination } = params;

  const force = !!flags.force;
  const refreshRows = flags.refreshRows ?? true;
  const refreshMeta = flags.refreshMeta ?? false;
  const refreshStats = flags.refreshStats ?? false;

  const limit = pagination?.limit ?? DEFAULT_LIMIT;
  const offset = pagination?.offset ?? DEFAULT_OFFSET;

  const hasColumns = Array.isArray(prev.columns) && prev.columns.length > 0;

  const rowsInfo = useConnectionStore.getState().getRowsWindowInfo(key);
  const hasRowsWindow = !!rowsInfo;

  // Check if rows for current page are already loaded
  const rowsMatchOffset = (rowsInfo?.streamOffset ?? -1) === offset;
  const hasAnyRowForPage =
    rowsMatchOffset && typeof rowsInfo?.loadedMax === "number"
      ? rowsInfo.loadedMax >= offset
      : false;

  const hasRowCount = typeof prev.rowCount === "number" && prev.rowCount >= 0;
  const hasSizeInfo = !!prev.sizeInfo;

  const hasStructure =
    Array.isArray(prev.structure) && prev.structure.length > 0;
  const hasConstraints =
    Array.isArray(prev.constraints) && prev.constraints.length > 0;

  const isFirstLoad = !hasColumns || !hasRowsWindow;
  const metaMissing = !hasStructure || !hasConstraints;

  // Columns are blocking requirement for UI
  const needColumns = force || isFirstLoad || !hasColumns;

  const paginationChanged = !rowsMatchOffset;
  const needRows =
    force ||
    isFirstLoad ||
    refreshRows ||
    paginationChanged ||
    (!hasAnyRowForPage && !rowsInfo?.running);

  const needRowCount =
    force || (!isFirstLoad && (!hasRowCount || refreshStats));
  const needSizeInfo =
    force || (!isFirstLoad && (!hasSizeInfo || refreshStats));
  const needMeta = force || (!isFirstLoad && (metaMissing || refreshMeta));

  const needAnyMetaWork =
    needColumns || needRowCount || needSizeInfo || needMeta;

  // Check if rows capacity needs update
  const desiredCap = Math.max(1000, limit * 4);
  const capMismatch = rowsInfo ? rowsInfo.cap !== desiredCap : true;
  const needRowsWithLimit =
    needRows || (capMismatch && (refreshRows || force || paginationChanged));

  return {
    key,
    prev,
    force,
    isFirstLoad,
    needColumns,
    needRows: needRowsWithLimit,
    needRowCount,
    needSizeInfo,
    needMeta,
    needAnyMetaWork,
  };
}

function shouldDoAnything(p: LoadPlan) {
  return (
    p.needColumns ||
    p.needRows ||
    p.needRowCount ||
    p.needSizeInfo ||
    p.needMeta
  );
}

function patchMeta(
  setMeta: (key: string, patch: any) => void,
  key: string,
  prev: any,
  patch: any
) {
  // Always fetch latest state to ensure we don't overwrite with stale 'prev'
  const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
  setMeta(key, { ...cur, ...patch });
}

function parseBusyOpId(err: unknown): string | null {
  const msg = getErrorMessage(err);
  const m = /^ERR_SQL_BUSY:([0-9a-f-]{36})$/i.exec(msg.trim());
  return m?.[1] ?? null;
}

function buildLoadSignature(params: {
  key: string;
  pagination?: TablePagination;
  flags: LoadFlags;
}) {
  const { key, pagination, flags } = params;
  const filters = (flags.filters ?? []).map((f) => ({
    column: f.column ?? "",
    operator: f.operator ?? "",
    value: f.value ?? "",
    enabled: !!f.enabled,
  }));

  return JSON.stringify({
    key,
    limit: pagination?.limit ?? DEFAULT_LIMIT,
    offset: pagination?.offset ?? DEFAULT_OFFSET,
    force: !!flags.force,
    refreshRows: flags.refreshRows ?? true,
    refreshMeta: flags.refreshMeta ?? false,
    refreshStats: flags.refreshStats ?? false,
    filterCombine: flags.filterCombine ?? "AND",
    filters,
  });
}

// =============================================================================
// Loaders (Single Responsibility)
// =============================================================================

async function loadColumns(params: {
  connId: string;
  schema: string;
  tableName: string;
  addLogQuery: (sql: string) => void;
}): Promise<ColumnRow[]> {
  const { connId, schema, tableName, addLogQuery } = params;
  const q = tableColumnsQuery(schema, tableName);
  const res = await runSqlQuery(connId, q);
  addLogQuery(q);

  return (res.rows as unknown[][])
    .map((r) => ({
      name: cellToString(r?.[0]),
      db_type: cellToString(r?.[1]),
    }))
    .filter(isNonEmptyName);
}

async function loadRowCount(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string) => void;
}): Promise<number> {
  const { connId, schema, tableName, engine, addLogQuery } = params;
  const q = tableRowCountQuery(schema, tableName, engine);
  const res = await runSqlQuery(connId, q);
  addLogQuery(q);
  return Number(cellToString((res.rows as unknown[][])?.[0]?.[0]));
}

async function loadSizeInfo(params: {
  connId: string;
  schema: string;
  tableName: string;
  addLogQuery: (sql: string) => void;
}): Promise<{ totalSize: string; dataSize: string; indexSize: string }> {
  const { connId, schema, tableName, addLogQuery } = params;
  const q = tableSizeInfoQuery(schema, tableName);
  const res = await runSqlQuery(connId, q);
  addLogQuery(q);

  const r0 = (res.rows as unknown[][])?.[0] ?? [];
  return {
    totalSize: cellToString(r0?.[0]) ?? "0",
    dataSize: cellToString(r0?.[1]) ?? "0",
    indexSize: cellToString(r0?.[2]) ?? "0",
  };
}

async function loadMeta(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string) => void;
}): Promise<{ structure: any[]; constraints: any[]; foreignKeys: any[] }> {
  const { connId, schema, tableName, engine, addLogQuery } = params;

  if (engine === "mysql" || engine === "mariadb") {
    const qStructure = tableStructuresMySqlQuery(schema, tableName);
    const structureRes = await runSqlQuery(connId, qStructure);
    addLogQuery(qStructure);

    const structure = (structureRes.rows as unknown[][]).map((row) => ({
      column_name: cellToString(row?.[1]),
      data_type: cellToString(row?.[2]),
      is_nullable: (cellToString(row?.[3]) ?? "").toLowerCase() === "yes",
      check: "",
      column_default: cellToString(row?.[4]),
      comment: cellToString(row?.[5]) ?? "",
    }));

    const qConstraints = tableConstraintsMySqlQuery(schema, tableName);
    const constraintsRes = await runSqlQuery(connId, qConstraints);
    addLogQuery(qConstraints);

    const constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
      index_name: cellToString(row?.[0]),
      index_algorithm: cellToString(row?.[1]),
      is_unique: Number(cellToString(row?.[2]) ?? "1") === 0,
      is_primary: cellToString(row?.[3])?.toLowerCase() === "true",
      index_definition: "",
      column_name: cellToString(row?.[4]) ?? "",
      condition: "",
      include: "",
      comment: "",
    }));

    return { structure, constraints, foreignKeys: [] };
  }

  // 1. Get OID
  const qOid = tableOidQuery(schema, tableName);
  const oidRes = await runSqlQuery(connId, qOid);
  addLogQuery(qOid);
  const oid = Number(cellToString((oidRes.rows as unknown[][])?.[0]?.[0]));

  // 2. Structure
  const qStructure = tableStructuresQuery(schema, tableName, oid);
  const structureRes = await runSqlQuery(connId, qStructure);
  addLogQuery(qStructure);

  const structure = (structureRes.rows as unknown[][]).map((row) => ({
    column_name: cellToString(row?.[1]),
    data_type: cellToString(row?.[2]),
    is_nullable: cellToString(row?.[8])?.toLowerCase() === "yes",
    check: cellToString(row?.[9]),
    column_default: cellToString(row?.[11]),
    comment: cellToString(row?.[12]),
  }));

  // 3. Constraints
  const qConstraints = tableConstraintsQuery(schema, tableName);
  const constraintsRes = await runSqlQuery(connId, qConstraints);
  addLogQuery(qConstraints);

  const constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
    index_name: cellToString(row?.[0]),
    index_algorithm: cellToString(row?.[1]),
    is_unique: cellToString(row?.[2])?.toLowerCase() === "true",
    is_primary: cellToString(row?.[3])?.toLowerCase() === "true",
    index_definition: cellToString(row?.[4]),
    column_name: cellToString(row?.[5]),
    condition: cellToString(row?.[6]),
    include: cellToString(row?.[7]),
    comment: cellToString(row?.[8]),
  }));

  // 4. Foreign keys (Postgres only)
  let foreignKeys: any[] = [];
  try {
    const qFk = tableForeignKeysQuery(schema, tableName);
    const fkRes = await runSqlQuery(connId, qFk);
    addLogQuery(qFk);
    foreignKeys = (fkRes.rows as unknown[][]).map((row) => ({
      constraint_name: cellToString(row?.[0]),
      table_schema: cellToString(row?.[1]),
      table_name: cellToString(row?.[2]),
      column_names: cellToString(row?.[3]),
      ref_table_schema: cellToString(row?.[4]),
      ref_table_name: cellToString(row?.[5]),
      ref_column_names: cellToString(row?.[6]),
      on_update: cellToString(row?.[7]) || "NO ACTION",
      on_delete: cellToString(row?.[8]) || "NO ACTION",
    }));
  } catch {
    // Ignore if FK query fails
  }

  return { structure, constraints, foreignKeys };
}

async function startRowsStream(params: {
  key: string;
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  limit: number;
  offset: number;
  addLogQuery: (sql: string) => void;
  resetCache?: boolean;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
}): Promise<void> {
  const {
    key,
    connId,
    schema,
    tableName,
    engine,
    limit,
    offset,
    addLogQuery,
    resetCache,
    filters,
    filterCombine = "AND",
  } = params;

  const q = tableDataQuery(
    schema,
    tableName,
    { limit, offset },
    filters,
    filterCombine,
    engine
  );
  addLogQuery(q);

  const store = useConnectionStore.getState();

  store.initRows(key, DEFAULT_ROWS_CAP);

  // Cancel previous stream for this table if any
  const old = store.getRowsWindowInfo(key);
  const oldOpId = old?.opId;
  if (oldOpId) {
    try {
      await operationCancel(oldOpId);
    } catch {}
  }

  const rowsOpId = await retryAsync(
    () =>
      startSqlQueryStream(connId, q, {
        batchSize: 200,
        maxRows: limit,
      }),
    {
      attempts: RETRY_ATTEMPTS,
      shouldRetry: (err) => Boolean(parseBusyOpId(err)),
      onRetry: async (err) => {
        const busyOpId = parseBusyOpId(err);
        if (!busyOpId) return;

        // Best effort: ask backend to cancel the stream currently holding the lock.
        try {
          await operationCancel(busyOpId);
        } catch {}
      },
      delayMs: (attempt) => 40 * attempt,
    }
  );

  const cap = Math.max(1000, limit * 4);

  // Begin stream in store (resets cache if requested)
  store.beginRowsStream(key, rowsOpId, cap, offset, resetCache);

  let unsub: (() => void) | null = null;

  unsub = await operationBus.subscribe(rowsOpId, {
    onChunk: (chunk: TableChunk) => {
      useConnectionStore.getState().applyRowsChunk(key, rowsOpId, chunk);
    },

    onDone: () => {
      const cur = useConnectionStore.getState().getRowsWindowInfo(key);
      if (!cur || cur.opId !== rowsOpId) return;
      try {
        unsub?.();
      } catch {}
      unsub = null;
      useConnectionStore.getState().endRowsStream(key, rowsOpId);
    },

    onError: (err: any) => {
      const cur = useConnectionStore.getState().getRowsWindowInfo(key);
      if (!cur || cur.opId !== rowsOpId) return;
      try {
        unsub?.();
      } catch {}
      unsub = null;
      useConnectionStore
        .getState()
        .failRowsStream(key, rowsOpId, getErrorMessage(err));
    },
  });
}

// =============================================================================
// Hook
// =============================================================================

export function useLoadTableData() {
  const tableDataMap = useConnectionStore((s) => s.tableDataMap);
  const setMeta = useConnectionStore((s) => s.addTableDataMap);
  const removeMeta = useConnectionStore((s) => s.removeTableDataMap);

  const setColumnsCache = useConnectionStore((s) => s.setColumnsCache);
  const setSizeInfoCache = useConnectionStore((s) => s.setSizeInfoCache);
  const addQueryHistory = useConnectionStore((s) => s.addQueryHistory);

  const columnsCache = useConnectionStore((s) => s.columnsCache);
  const sizeInfoCache = useConnectionStore((s) => s.sizeInfoCache);

  const profileTabs = useScreenStore((s) => s.profileTabs);
  const activeProfileScreen = useScreenStore((s) => s.activeProfileScreen);

  // Ref to track active loading requests (Deduplication)
  const loadingKeysRef = useRef<Set<string>>(new Set());

  const activeTab = useMemo(() => {
    if (!activeProfileScreen || activeProfileScreen === "main") return null;
    return profileTabs.find((t) => t.id === activeProfileScreen) ?? null;
  }, [profileTabs, activeProfileScreen]);

  const addLogQuery = useCallback(
    (sql: string) => {
      if (!activeTab) return;
      addQueryHistory(activeTab.id, sql);
    },
    [activeTab, addQueryHistory]
  );

  const ensureRuntimeConn = useCallback(
    async (key: string) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");
      const meta = tableDataMap[key];
      if (meta?.connectionId) return meta.connectionId;
      const res = await profileConnect(activeTab.profileId);
      return res.connection.id;
    },
    [activeTab, tableDataMap]
  );

  const loadTableData = useCallback(
    async (
      schema: string,
      tableName: string,
      pagination?: TablePagination,
      flags: LoadFlags = {}
    ) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");

      const key = tableKey(activeProfileScreen, schema, tableName);
      const loadSignature = buildLoadSignature({ key, pagination, flags });
      const existingLoad = inflightLoadBySignature.get(loadSignature);
      if (existingLoad) {
        return existingLoad;
      }

      const task = (async () => {
        // --- DEDUPLICATION CHECK ---
        // If already loading this key and not forced, skip to avoid race conditions
        if (loadingKeysRef.current.has(key) && !flags.force) {
          return;
        }
        loadingKeysRef.current.add(key);

        try {
          const prev = tableDataMap[key] ?? EMPTY_META;
          const plan = computeLoadPlan({ key, prev, flags, pagination });

          if (!shouldDoAnything(plan)) return;

          const limit = pagination?.limit ?? DEFAULT_LIMIT;
          const offset = pagination?.offset ?? DEFAULT_OFFSET;
          const isPostgres = activeTab.engine === "postgres";
          const supportsMeta =
            activeTab.engine === "postgres" ||
            activeTab.engine === "mysql" ||
            activeTab.engine === "mariadb";

          // Set busy/error state
          if (plan.needAnyMetaWork)
            patchMeta(setMeta, key, prev, { busy: true, error: null });
          else patchMeta(setMeta, key, prev, { error: null });

          // Ensure connection
          let connId: string;
          try {
            connId = activeTab.runtimeConnectionId
              ? activeTab.runtimeConnectionId
              : await ensureRuntimeConn(key);
          } catch (e) {
            patchMeta(setMeta, key, prev, {
              busy: false,
              error: getErrorMessage(e),
            });
            return;
          }

          patchMeta(setMeta, key, prev, {
            connectionId: prev.connectionId ?? connId,
          });

          // --- 1. APPLY CACHES (Instant UI Feedback) ---
          const cachedCols = columnsCache[key];
          if (
            (!Array.isArray(prev.columns) || prev.columns.length === 0) &&
            Array.isArray(cachedCols) &&
            cachedCols.length > 0
          ) {
            patchMeta(setMeta, key, prev, { columns: cachedCols });
          }

          const cachedSize = sizeInfoCache[key];
          if (!prev.sizeInfo && cachedSize) {
            patchMeta(setMeta, key, prev, { sizeInfo: cachedSize });
          }

          // --- 2. LOAD COLUMNS (Blocking) ---
          // We must have columns before processing rows to ensure correct data mapping.
          if (plan.needColumns) {
            try {
              const columns = await loadColumns({
                connId,
                schema,
                tableName,
                addLogQuery,
              });

              const curPrev =
                useConnectionStore.getState().tableDataMap[key] ?? prev;

              patchMeta(setMeta, key, curPrev, {
                columns,
                connectionId: curPrev.connectionId ?? connId,
              });

              try {
                setColumnsCache(key, columns as any);
              } catch {}
            } catch (e) {
              patchMeta(setMeta, key, prev, {
                busy: false,
                error: getErrorMessage(e),
              });
              // Stop here if columns fail
              return;
            }
          }

          // --- 3. START ROWS STREAM (Fire & Forget) ---
          // Runs independently of meta tasks.
          if (plan.needRows) {
            void (async () => {
              try {
                // Force refresh means we should invalidate existing cache
                const shouldReset = !!flags.force;

                await startRowsStream({
                  key,
                  connId,
                  schema,
                  tableName,
                  engine: activeTab.engine,
                  limit,
                  offset,
                  addLogQuery,
                  resetCache: shouldReset,
                  filters: flags.filters,
                  filterCombine: flags.filterCombine ?? "AND",
                });
              } catch (e) {
                const curMeta =
                  useConnectionStore.getState().tableDataMap[key] ?? prev;
                patchMeta(setMeta, key, curMeta, {
                  busy: false,
                  error: getErrorMessage(e),
                });
              }
            })();
          }

          // --- 4. LOAD META (Parallel) ---
          const metaTasks: Promise<void>[] = [];

          if (plan.needRowCount) {
            metaTasks.push(
              (async () => {
                const rowCount = await loadRowCount({
                  connId,
                  schema,
                  tableName,
                  engine: activeTab.engine,
                  addLogQuery,
                });
                patchMeta(setMeta, key, prev, { rowCount });
              })()
            );
          }

          if (plan.needSizeInfo && isPostgres) {
            metaTasks.push(
              (async () => {
                const sizeInfo = await loadSizeInfo({
                  connId,
                  schema,
                  tableName,
                  addLogQuery,
                });
                patchMeta(setMeta, key, prev, { sizeInfo });
                try {
                  setSizeInfoCache(key, sizeInfo as any);
                } catch {}
              })()
            );
          }

          if (plan.needMeta && supportsMeta) {
            metaTasks.push(
              (async () => {
                const { structure, constraints, foreignKeys } = await loadMeta({
                  connId,
                  schema,
                  tableName,
                  engine: activeTab.engine,
                  addLogQuery,
                });
                patchMeta(setMeta, key, prev, {
                  structure,
                  constraints,
                  foreignKeys,
                });
              })()
            );
          }

          // If no meta tasks needed, we are done
          if (metaTasks.length === 0) {
            // Only clear busy if we set it earlier
            if (plan.needAnyMetaWork) {
              patchMeta(setMeta, key, prev, { busy: false });
            }
            return;
          }

          // Wait for all meta tasks to settle
          const results = await Promise.allSettled(metaTasks);
          const firstErr = results.find((r) => r.status === "rejected") as
            | PromiseRejectedResult
            | undefined;

          if (firstErr) {
            patchMeta(setMeta, key, prev, {
              busy: false,
              error: getErrorMessage(firstErr.reason),
            });
            return;
          }

          // All done
          patchMeta(setMeta, key, prev, { busy: false });
        } finally {
          // CLEANUP: Always remove deduplication lock
          loadingKeysRef.current.delete(key);
        }
      })();

      inflightLoadBySignature.set(loadSignature, task);
      try {
        await task;
      } finally {
        const current = inflightLoadBySignature.get(loadSignature);
        if (current === task) {
          inflightLoadBySignature.delete(loadSignature);
        }
      }
    },
    [
      activeTab,
      activeProfileScreen,
      tableDataMap,
      columnsCache,
      sizeInfoCache,
      setMeta,
      ensureRuntimeConn,
      addLogQuery,
      setColumnsCache,
      setSizeInfoCache,
    ]
  );

  const getTableData = useCallback(
    (activeScreen: string, schema: string, tableName: string) => {
      const key = tableKey(activeScreen, schema, tableName);
      return tableDataMap[key] ?? EMPTY_META;
    },
    [tableDataMap]
  );

  const removeTableData = useCallback(
    (schema: string, tableName: string) => {
      const key = tableKey(activeProfileScreen, schema, tableName);

      const rowsInfo = useConnectionStore.getState().getRowsWindowInfo(key);
      if (rowsInfo?.opId) {
        operationCancel(rowsInfo.opId).catch(() => {});
      }
      useConnectionStore.getState().clearRows(key);

      removeMeta(key);
    },
    [activeProfileScreen, removeMeta]
  );

  return {
    loadTableData,
    getTableData,
    removeTableData,
  };
}
