import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  TableItem,
  TableSizeInfo,
  TableConstraint,
  TableStructure,
  TableColumn,
  SqlQuery,
  TableWindow,
} from "src/types";
import type { ColumnMeta, QueryResult } from "src/lib/tauri/types";
import { PatchMap } from "src/utils/generateSql";

/* =============================================================================
 * Row cache (max gain)
 * ============================================================================= */
// Simple in-memory FIFO cache (cheap + predictable)

const ROW_CACHE_LIMIT = 20000;
const ROW_CACHE_EVICT_BATCH = 512;

function cachePut(
  cache: { map: Map<number, unknown[]>; order: number[] },
  idx: number,
  row: unknown[]
) {
  if (!cache.map.has(idx)) cache.order.push(idx);
  cache.map.set(idx, row);

  // Batch eviction (avoid O(n) shift per insert)
  if (cache.order.length > ROW_CACHE_LIMIT + ROW_CACHE_EVICT_BATCH) {
    for (let i = 0; i < ROW_CACHE_EVICT_BATCH; i++) {
      const oldest = cache.order.shift();
      if (oldest === undefined) break;
      cache.map.delete(oldest);
    }
  }
}

function cacheGet(
  cache: { map: Map<number, unknown[]>; order: number[] } | undefined,
  idx: number
) {
  if (!cache) return undefined;
  return cache.map.get(idx);
}

/* =============================================================================
 * Base states
 * ============================================================================= */

export type SchemaState = {
  data: string[];
  busy: boolean;
  error: string | null;
};

export type SqlResultState = {
  busy: boolean;
  error: string | null;
  result: QueryResult | null;
  lastRunAt?: number;
};

export type TableState = {
  data: TableItem[];
  busy: boolean;
  error: string | null;
};

export type TableMetaState = {
  columns: ColumnMeta[] | null;
  structure: TableStructure[] | null;
  constraints: TableConstraint[] | null;
  sizeInfo: TableSizeInfo | null;
  rowCount: number | null;
  connectionId: string | null; // profile / DB connection
  busy: boolean;
  error: string | null;
};

// =============================================================================
// Rows notify scheduler (batch state updates to max 1/frame)
// =============================================================================

type PendingRowsMeta = {
  loadedMax: number;
  lastChunkAt: number;
};

function raf(cb: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb);
  else setTimeout(cb, 16);
}

export type TableDataState = TableMetaState;

export type DataKey = "structure" | "constraints" | "data";
export type DataAction = "create" | "update" | "delete";

export type DataPatchesState = {
  dataKey: DataKey;
  action: DataAction;
  tableData: TableDataState;
  tableWindow: TableWindow;
  rowKey: string;
  data: Record<string, any>;
};

export type NewTableDataState = {
  tableName: string;
  primaryKey: string | string[];
  columns: TableColumn[];
};

/* =============================================================================
 * Rows windowing (max gain)
 * ============================================================================= */

export type TableRowState = {
  opId?: string;

  // Window buffer: global row index = base + i
  base: number;
  cap: number;
  rows: (unknown[] | undefined)[];

  // Offset used for current SQL stream (LIMIT/OFFSET)
  // Global row index = streamOffset + chunk.row_offset + i
  streamOffset: number;

  // Current viewport (global row indices)
  viewportStart: number;
  viewportEnd: number;

  // Progress / status (global)
  loadedMax: number; // max global row index received so far
  running: boolean;
  error: string | null;
  truncated: boolean;

  // bump to trigger rerender (batched by scheduler)
  version: number;

  startedAt?: number;
  lastChunkAt?: number;
};

const DEFAULT_ROWS_CAP = 5000;

function clampNonNeg(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function makeRowsState(cap: number): TableRowState {
  const c = Math.max(200, Math.floor(cap || DEFAULT_ROWS_CAP));
  return {
    opId: undefined,
    base: 0,
    cap: c,
    rows: new Array(c).fill(undefined),

    streamOffset: 0,

    viewportStart: 0,
    viewportEnd: 0,

    loadedMax: -1,
    running: false,
    error: null,
    truncated: false,

    version: 0,
  };
}

/* =============================================================================
 * Store
 * ============================================================================= */

export type ConnectionState = {
  tables: Record<string, TableState>;
  schemas: Record<string, SchemaState>;
  queryHistory: Record<string, SqlQuery[]>;

  columnsCache: Record<string, ColumnMeta[]>;
  sizeInfoCache: Record<string, TableSizeInfo>;

  tableDataMap: Record<string, TableMetaState>;
  sqlResults: Record<string, SqlResultState>;

  tableStructure: Record<string, Record<string, TableStructure[]>>;
  tableConstraints: Record<string, Record<string, TableConstraint[]>>;
  dataPatchMap: Record<string, PatchMap>;
  newTableData: Record<string, Record<string, NewTableDataState>>;

  tableRowsByKey: Record<string, TableRowState>;
  tableRowCacheByKey: Record<
    string,
    { map: Map<number, unknown[]>; order: number[] }
  >;

  addQueryHistory: (windowId: string, sql: string) => void;
  clearQueryHistory: (windowId: string) => void;

  setSqlResult: (windowId: string, patch: Partial<SqlResultState>) => void;
  clearSqlResult: (windowId: string) => void;

  setTables: (windowId: string, data: TableState) => void;
  addTable: (windowId: string, table: TableItem) => void;

  setSchemas: (tabIwindowId: string, data: SchemaState) => void;
  addSchema: (windowId: string, schema: string) => void;

  addTableDataMap: (windowId: string, data: TableMetaState) => void;
  removeTableDataMap: (windowId: string) => void;

  setColumnsCache: (key: string, cols: ColumnMeta[]) => void;
  setSizeInfoCache: (key: string, info: TableSizeInfo) => void;

  setTableStructure: (
    tabId: string,
    tableWindowId: string,
    structure: TableStructure[]
  ) => void;

  updateTableStructure: (
    tabId: string,
    tableWindowId: string,
    rowIndex: number,
    field: keyof TableStructure,
    value: string | boolean
  ) => void;

  setTableConstraints: (
    tabId: string,
    tableWindowId: string,
    constraints: TableConstraint[]
  ) => void;

  updateTableConstraints: (
    tabId: string,
    tableWindowId: string,
    rowIndex: number,
    field: keyof TableConstraint,
    value: string | boolean
  ) => void;

  clearTableStructure: (tabId: string, tableWindowId?: string) => void;
  clearTableConstraints: (tabId: string, tableWindowId?: string) => void;

  setDataPatchMap: (tabId: string, props: DataPatchesState) => void;
  removeDataPatch: (
    tabId: string,
    tableWindowId: string,
    action: DataAction,
    dataKey: DataKey,
    rowKey: string
  ) => void;
  clearDataPatchMap: (tabId: string, tableWindowId?: string) => void;

  setNewTableData: (
    tabId: string,
    tableWindowId: string,
    data: NewTableDataState
  ) => void;
  clearNewTableData: (tabId: string, tableWindowId?: string) => void;

  /* ===========================================================================
   * Rows API (max gain)
   * =========================================================================== */

  initRows: (key: string, cap?: number) => void;
  clearRows: (key: string) => void;

  beginRowsStream: (
    key: string,
    opId: string,
    cap?: number,
    streamOffset?: number
  ) => void;

  endRowsStream: (key: string, opId: string) => void;
  failRowsStream: (key: string, opId: string, error: string) => void;

  setViewport: (key: string, start: number, end: number) => void;
  shiftWindowToViewport: (key: string) => void;

  applyRowsChunk: (key: string, opId: string, chunk: any) => void;

  getRowAt: (key: string, rowIndex: number) => unknown[] | undefined;
  getRowsWindowInfo: (key: string) => TableRowState | null;
};

export const useConnectionStore = create<ConnectionState>()(
  subscribeWithSelector((set, get) => {
    // -------------------------------------------------------------------------
    // Batched notify: at most 1 state update per frame per table key
    // -------------------------------------------------------------------------
    const pendingKeys = new Set<string>();
    const pendingMeta = new Map<string, PendingRowsMeta>();
    let scheduled = false;

    const scheduleRowsNotify = (key: string) => {
      pendingKeys.add(key);
      if (scheduled) return;
      scheduled = true;

      raf(() => {
        scheduled = false;

        const keys = Array.from(pendingKeys);
        pendingKeys.clear();
        if (keys.length === 0) return;

        set((s) => {
          let changed = false;
          const nextRowsByKey = { ...s.tableRowsByKey };

          for (const k of keys) {
            const st = nextRowsByKey[k];
            if (!st) continue;

            const meta = pendingMeta.get(k);
            if (meta) {
              st.loadedMax = Math.max(st.loadedMax, meta.loadedMax);
              st.lastChunkAt = meta.lastChunkAt;
              pendingMeta.delete(k);
            }

            st.version += 1;
            changed = true;
          }

          return changed ? { tableRowsByKey: nextRowsByKey } : s;
        });
      });
    };

    return {
      tables: {},
      schemas: {},
      tableDataMap: {},

      sqlResults: {},
      queryHistory: {},

      columnsCache: {},
      sizeInfoCache: {},

      tableStructure: {},
      tableConstraints: {},
      dataPatchMap: {},
      newTableData: {},

      tableRowsByKey: {},
      tableRowCacheByKey: {},

      /* =========================================================================
       * Existing actions (keep as your current implementation)
       * ========================================================================= */

      setSqlResult: (windowId, patch) =>
        set((s) => {
          const prev = s.sqlResults[windowId] ?? {
            busy: false,
            error: null,
            result: null,
          };

          const next = { ...prev, ...patch };

          if (
            prev.busy === next.busy &&
            prev.error === next.error &&
            prev.result === next.result &&
            prev.lastRunAt === next.lastRunAt
          ) {
            return s;
          }

          return {
            sqlResults: {
              ...s.sqlResults,
              [windowId]: next,
            },
          };
        }),

      clearSqlResult: (windowId) =>
        set((s) => {
          if (!s.sqlResults[windowId]) return s;
          const { [windowId]: _, ...rest } = s.sqlResults;
          return { sqlResults: rest };
        }),

      setSchemas: (windowId, data) =>
        set((s) => ({
          schemas: {
            ...s.schemas,
            [windowId]: data,
          },
        })),

      addSchema: (windowId, schema) =>
        set((s) => ({
          schemas: {
            ...s.schemas,
            [windowId]: {
              ...(s.schemas[windowId] || {
                data: [],
                busy: false,
                error: null,
              }),
              data: [...(s.schemas[windowId]?.data || []), schema],
            },
          },
        })),

      setTables: (windowId, data) =>
        set((s) => ({
          tables: {
            ...s.tables,
            [windowId]: data,
          },
        })),

      addTable: (windowId, table) =>
        set((s) => ({
          tables: {
            ...s.tables,
            [windowId]: {
              ...(s.tables[windowId] || { data: [], busy: false, error: null }),
              data: [...(s.tables[windowId]?.data || []), table],
            },
          },
        })),

      addTableDataMap: (windowId, tableData) =>
        set((s) => ({
          tableDataMap: {
            ...s.tableDataMap,
            [windowId]: tableData,
          },
        })),

      removeTableDataMap: (windowId) =>
        set((s) => {
          const { [windowId]: _, ...rest } = s.tableDataMap;
          return { tableDataMap: rest };
        }),

      setColumnsCache: (key, cols) =>
        set((s) => ({ columnsCache: { ...s.columnsCache, [key]: cols } })),

      setSizeInfoCache: (key, info) =>
        set((s) => ({ sizeInfoCache: { ...s.sizeInfoCache, [key]: info } })),

      addQueryHistory: (windowId, sql) =>
        set((s) => ({
          queryHistory: {
            ...s.queryHistory,
            [windowId]: [
              ...(s.queryHistory[windowId] || []),
              { sql, timestamp: new Date() },
            ],
          },
        })),

      clearQueryHistory: (windowId) =>
        set((s) => ({
          queryHistory: {
            ...s.queryHistory,
            [windowId]: [],
          },
        })),

      setTableStructure: (tabId, tableWindowId, structure) =>
        set((s) => ({
          tableStructure: {
            ...s.tableStructure,
            [tabId]: {
              ...s.tableStructure[tabId],
              [tableWindowId]: structure,
            },
          },
        })),

      updateTableStructure: (tabId, tableWindowId, rowIndex, field, value) =>
        set((s) => {
          const structure = s.tableStructure[tabId]?.[tableWindowId] ?? [];
          structure[rowIndex] = { ...structure[rowIndex]!, [field]: value };
          return {
            tableStructure: {
              ...s.tableStructure,
              [tabId]: {
                ...s.tableStructure[tabId],
                [tableWindowId]: structure,
              },
            },
          };
        }),

      setTableConstraints: (tabId, tableWindowId, constraints) =>
        set((s) => ({
          tableConstraints: {
            ...s.tableConstraints,
            [tabId]: {
              ...s.tableConstraints[tabId],
              [tableWindowId]: constraints,
            },
          },
        })),

      updateTableConstraints: (tabId, tableWindowId, rowIndex, field, value) =>
        set((s) => {
          const constraints = s.tableConstraints[tabId]?.[tableWindowId] ?? [];
          constraints[rowIndex] = { ...constraints[rowIndex]!, [field]: value };
          return {
            tableConstraints: {
              ...s.tableConstraints,
              [tabId]: {
                ...s.tableConstraints[tabId],
                [tableWindowId]: constraints,
              },
            },
          };
        }),

      clearTableStructure: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.tableStructure[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.tableStructure[tabId];
            return { tableStructure: { ...s.tableStructure, [tabId]: rest } };
          }

          return { tableStructure: { ...s.tableStructure, [tabId]: {} } };
        }),

      clearTableConstraints: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.tableConstraints[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.tableConstraints[tabId];
            return {
              tableConstraints: { ...s.tableConstraints, [tabId]: rest },
            };
          }

          return { tableConstraints: { ...s.tableConstraints, [tabId]: {} } };
        }),

      setDataPatchMap: (tabId: string, props: DataPatchesState) => {
        const { dataKey, action, tableData, tableWindow, rowKey, data } = props;
        const tableWindowId = tableWindow.id;

        set((s) => ({
          dataPatchMap: {
            ...s.dataPatchMap,
            [tabId]: {
              ...(s.dataPatchMap[tabId] ?? {}),
              [tableWindowId]: {
                tableData,
                tableWindow,
                patches: {
                  ...(s.dataPatchMap[tabId]?.[tableWindowId]?.patches ?? {}),
                  [action]: {
                    ...(s.dataPatchMap[tabId]?.[tableWindowId]?.patches?.[
                      action
                    ] ?? {}),
                    [dataKey]: {
                      ...(s.dataPatchMap[tabId]?.[tableWindowId]?.patches?.[
                        action
                      ]?.[dataKey] ?? {}),
                      [rowKey]: {
                        ...(s.dataPatchMap[tabId]?.[tableWindowId]?.patches?.[
                          action
                        ]?.[dataKey]?.[rowKey] ?? {}),
                        ...data,
                      },
                    },
                  },
                },
              },
            },
          },
        }));
      },

      removeDataPatch: (tabId, tableWindowId, action, dataKey, rowKey) =>
        set((s) => {
          const windowData = s.dataPatchMap[tabId]?.[tableWindowId];
          if (!windowData?.patches?.[action]?.[dataKey]?.[rowKey]) return s;

          const patches = { ...windowData.patches };
          const actionPatches = { ...patches[action] };
          const dataKeyPatches = { ...actionPatches[dataKey] };
          const { [rowKey]: _, ...restDataKeyPatches } = dataKeyPatches;

          let finalPatches: typeof patches;

          if (Object.keys(restDataKeyPatches).length === 0) {
            const { [dataKey]: _, ...restActionPatches } = actionPatches;
            if (Object.keys(restActionPatches).length === 0) {
              const { [action]: _, ...restPatches } = patches;
              finalPatches = restPatches;
            } else {
              finalPatches = { ...patches, [action]: restActionPatches };
            }
          } else {
            actionPatches[dataKey] = restDataKeyPatches;
            finalPatches = { ...patches, [action]: actionPatches };
          }

          const cleanedPatches =
            Object.keys(finalPatches).length > 0 ? finalPatches : {};

          return {
            dataPatchMap: {
              ...s.dataPatchMap,
              [tabId]: {
                ...s.dataPatchMap[tabId],
                [tableWindowId]: {
                  ...windowData,
                  patches: cleanedPatches,
                },
              },
            },
          };
        }),

      clearDataPatchMap: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.dataPatchMap[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.dataPatchMap[tabId];
            return { dataPatchMap: { ...s.dataPatchMap, [tabId]: rest } };
          }

          const { [tabId]: _, ...rest } = s.dataPatchMap;
          return { dataPatchMap: rest };
        }),

      setNewTableData: (tabId, tableWindowId, data) =>
        set((s) => ({
          newTableData: {
            ...s.newTableData,
            [tabId]: {
              ...s.newTableData[tabId],
              [tableWindowId]: data,
            },
          },
        })),

      clearNewTableData: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.newTableData[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.newTableData[tabId];
            return { newTableData: { ...s.newTableData, [tabId]: rest } };
          }

          return { newTableData: { ...s.newTableData, [tabId]: {} } };
        }),

      /* ===========================================================================
       * Rows API (batched notify)
       * =========================================================================== */

      initRows: (key, cap) =>
        set((s) => {
          if (s.tableRowsByKey[key]) return s;
          return {
            tableRowsByKey: {
              ...s.tableRowsByKey,
              [key]: makeRowsState(cap ?? DEFAULT_ROWS_CAP),
            },
          };
        }),

      clearRows: (key) =>
        set((s) => {
          if (!s.tableRowsByKey[key] && !s.tableRowCacheByKey[key]) return s;

          const { [key]: _, ...restRows } = s.tableRowsByKey;
          const { [key]: __, ...restCache } = s.tableRowCacheByKey;

          return { tableRowsByKey: restRows, tableRowCacheByKey: restCache };
        }),

      beginRowsStream: (key, opId, cap, streamOffset = 0) =>
        set((s) => {
          const prev =
            s.tableRowsByKey[key] ?? makeRowsState(cap ?? DEFAULT_ROWS_CAP);
          const nextCap = cap ? Math.max(200, Math.floor(cap)) : prev.cap;

          const base = clampNonNeg(streamOffset);

          const next: TableRowState = {
            ...prev,
            opId,
            cap: nextCap,
            base,
            streamOffset: base,
            rows: new Array(nextCap).fill(undefined),
            loadedMax: base - 1,
            running: true,
            error: null,
            truncated: false,
            startedAt: Date.now(),
            lastChunkAt: undefined,
            // version bump is scheduled
            version: prev.version,
          };

          const nextCache = {
            ...s.tableRowCacheByKey,
            [key]: { map: new Map<number, unknown[]>(), order: [] },
          };

          raf(() => scheduleRowsNotify(key));

          return {
            tableRowsByKey: {
              ...s.tableRowsByKey,
              [key]: next,
            },
            tableRowCacheByKey: nextCache,
          };
        }),

      endRowsStream: (key, opId) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev || prev.opId !== opId) return s;

          const nextRowsByKey = { ...s.tableRowsByKey };
          nextRowsByKey[key] = { ...prev, running: false };

          raf(() => scheduleRowsNotify(key));
          return { tableRowsByKey: nextRowsByKey };
        }),

      failRowsStream: (key, opId, error) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev || prev.opId !== opId) return s;

          const nextRowsByKey = { ...s.tableRowsByKey };
          nextRowsByKey[key] = { ...prev, running: false, error };

          raf(() => scheduleRowsNotify(key));
          return { tableRowsByKey: nextRowsByKey };
        }),

      // IMPORTANT: no rerender on scroll
      setViewport: (key, start, end) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev) return s;

          const vs = clampNonNeg(start);
          const ve = clampNonNeg(end);

          if (prev.viewportStart === vs && prev.viewportEnd === ve) return s;

          prev.viewportStart = vs;
          prev.viewportEnd = ve;
          return s;
        }),

      shiftWindowToViewport: (key) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev) return s;

          const overscan = Math.min(1500, Math.floor(prev.cap * 0.4));
          const desiredBase = Math.max(0, prev.viewportStart - overscan);

          const curStart = prev.base;
          const curEnd = prev.base + prev.cap;

          const stillOk =
            prev.viewportStart >= curStart + Math.floor(overscan * 0.3) &&
            prev.viewportEnd <= curEnd - Math.floor(overscan * 0.3);

          if (stillOk) return s;

          const nextRows = new Array(prev.cap).fill(undefined);

          const overlapStart = Math.max(curStart, desiredBase);
          const overlapEnd = Math.min(curEnd, desiredBase + prev.cap);

          if (overlapEnd > overlapStart) {
            const len = overlapEnd - overlapStart;
            const srcOff = overlapStart - curStart;
            const dstOff = overlapStart - desiredBase;
            for (let i = 0; i < len; i++) {
              nextRows[dstOff + i] = prev.rows[srcOff + i];
            }
          }

          const cache = s.tableRowCacheByKey[key];
          if (cache) {
            for (let i = 0; i < prev.cap; i++) {
              if (nextRows[i] !== undefined) continue;
              const rowIndex = desiredBase + i;
              const cached = cacheGet(cache, rowIndex);
              if (cached !== undefined) nextRows[i] = cached;
            }
          }

          const nextRowsByKey = { ...s.tableRowsByKey };
          nextRowsByKey[key] = {
            ...prev,
            base: desiredBase,
            rows: nextRows,
            version: prev.version,
          };

          raf(() => scheduleRowsNotify(key));
          return { tableRowsByKey: nextRowsByKey };
        }),

      applyRowsChunk: (key, opId, chunk) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev || prev.opId !== opId) return s;

          const incoming = (chunk?.rows ?? []) as unknown[][];
          if (!incoming.length) return s;

          const localOff = clampNonNeg(chunk?.row_offset ?? 0);

          const base = prev.base;
          const end = base + prev.cap;
          const streamOffset = prev.streamOffset;

          let cache = s.tableRowCacheByKey[key];
          let cacheChanged = false;

          if (!cache) {
            cache = { map: new Map<number, unknown[]>(), order: [] };
            cacheChanged = true;
          }

          const lastChunkAt = Date.now();
          let loadedMax = prev.loadedMax;

          let touched = 0;

          for (let i = 0; i < incoming.length; i++) {
            const globalRowIndex = streamOffset + localOff + i;
            const row = incoming[i]!;
            if (globalRowIndex > loadedMax) loadedMax = globalRowIndex;

            cachePut(cache, globalRowIndex, row);

            if (globalRowIndex < base || globalRowIndex >= end) continue;
            prev.rows[globalRowIndex - base] = row;
            touched++;
          }

          const prevMeta = pendingMeta.get(key);
          if (!prevMeta) {
            pendingMeta.set(key, { loadedMax, lastChunkAt });
          } else {
            prevMeta.loadedMax = Math.max(prevMeta.loadedMax, loadedMax);
            prevMeta.lastChunkAt = lastChunkAt;
          }

          if (touched > 0 || loadedMax > prev.loadedMax) {
            scheduleRowsNotify(key);
          }

          if (cacheChanged) {
            return {
              tableRowCacheByKey: {
                ...s.tableRowCacheByKey,
                [key]: cache,
              },
            };
          }

          return s;
        }),

      getRowAt: (key, rowIndex) => {
        const st = get().tableRowsByKey[key];
        if (!st) return undefined;

        const idx = clampNonNeg(rowIndex);

        if (idx >= st.base && idx < st.base + st.cap) {
          const v = st.rows[idx - st.base];
          if (v !== undefined) return v as any;
        }

        const cache = get().tableRowCacheByKey[key];
        return cacheGet(cache, idx) as any;
      },

      getRowsWindowInfo: (key) => {
        const st = get().tableRowsByKey[key];
        return st ?? null;
      },
    };
  })
);
