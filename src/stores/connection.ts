import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  TableItem,
  TableSizeInfo,
  TableConstraint,
  TableStructure,
  TableColumn,
  ForeignKeyInfo,
  SqlQuery,
  TableWindow,
} from "src/types";
import type { ColumnMeta, QueryResult } from "src/lib/tauri/types";
import { PatchMap } from "src/utils/generateSql";
import { cellToString } from "src/utils/convert";
import { DATA_ACTIONS, DATA_KEYS } from "src/constant";
import { TableFilterCondition } from "src/hooks/queries";

/* =============================================================================
 * Row cache (max gain)
 * ============================================================================= */
// Simple in-memory FIFO cache (cheap + predictable)

const ROW_CACHE_LIMIT = 100000;
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
  foreignKeys: ForeignKeyInfo[] | null;
  sizeInfo: TableSizeInfo | null;
  rowCount: number | null;
  connectionId: string | null; // profile / DB connection
  busy: boolean;
  error: string | null;
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

export type TableFilterState = {
  filterBarVisible: boolean;
  filters: TableFilterCondition[];
  filterCombine: "AND" | "OR";
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
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

export const DEFAULT_ROWS_CAP = 1000;

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
  tableFilterByKey: Record<string, TableFilterState>;

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

  setTableFilter: (key: string, filter: TableFilterState) => void;
  clearTableFilter: (key: string, visible?: boolean) => void;

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
  resetRows: (key: string) => void;

  beginRowsStream: (
    key: string,
    opId: string,
    cap?: number,
    streamOffset?: number,
    resetCache?: boolean // <--- UPDATED: Add resetCache flag
  ) => void;

  endRowsStream: (key: string, opId: string) => void;
  failRowsStream: (key: string, opId: string, error: string) => void;

  setViewport: (key: string, start: number, end: number) => void;
  shiftWindowToViewport: (key: string) => void;

  applyRowsChunk: (key: string, opId: string, chunk: any) => void;

  getRowAt: (key: string, rowIndex: number) => unknown[] | undefined;
  getRowsWindowInfo: (key: string) => TableRowState | null;

  updateRow: (key: string, rowIndex: number, row: unknown[]) => void;
  addRow: (key: string, row: unknown[], insertAfterIndex?: number) => void;
  removeRow: (key: string, globalRowIndex: number) => void;
};

export const useConnectionStore = create<ConnectionState>()(
  subscribeWithSelector((set, get) => {
    // -------------------------------------------------------------------------
    // Batched notify: at most 1 state update per frame per table key
    // -------------------------------------------------------------------------
    type PendingMeta = { loadedMax: number; lastChunkAt: number };

    const pendingMeta = new Map<string, PendingMeta>();
    const rafByKey = new Map<string, number>();

    function scheduleRowsNotify(key: string, opts?: { immediate?: boolean }) {
      const immediate = !!opts?.immediate;

      const flush = () => {
        rafByKey.delete(key);

        const meta = pendingMeta.get(key);
        if (!meta) return;
        pendingMeta.delete(key);

        useConnectionStore.setState((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev) return s;

          // ✅ IMPORTANT: bump version so UI knows data changed
          const next = {
            ...prev,
            loadedMax: Math.max(prev.loadedMax ?? -1, meta.loadedMax),
            lastChunkAt: meta.lastChunkAt,
            version: (prev.version ?? 0) + 1,
          };

          return {
            tableRowsByKey: { ...s.tableRowsByKey, [key]: next },
          };
        });
      };

      if (immediate) {
        // Nếu đã có RAF pending thì hủy luôn để flush ngay
        const raf = rafByKey.get(key);
        if (raf) {
          cancelAnimationFrame(raf);
          rafByKey.delete(key);
        }
        flush();
        return;
      }

      if (rafByKey.has(key)) return;

      const raf = requestAnimationFrame(() => flush());
      rafByKey.set(key, raf);
    }

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

      tableFilterByKey: {},

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
          const newStructure = [...structure];
          newStructure[rowIndex] = {
            ...newStructure[rowIndex]!,
            [field]: value,
          };
          return {
            tableStructure: {
              ...s.tableStructure,
              [tabId]: {
                ...s.tableStructure[tabId],
                [tableWindowId]: newStructure,
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
          const newConstraints = [...constraints];
          newConstraints[rowIndex] = {
            ...newConstraints[rowIndex]!,
            [field]: value,
          };
          return {
            tableConstraints: {
              ...s.tableConstraints,
              [tabId]: {
                ...s.tableConstraints[tabId],
                [tableWindowId]: newConstraints,
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

        set((s) => {
          const existingRowPatch =
            s.dataPatchMap[tabId]?.[tableWindowId]?.patches?.[action]?.[
              dataKey
            ]?.[rowKey];

          let dataToWrite: Record<string, any> = {
            ...(existingRowPatch ?? {}),
            ...data,
          };

          // If changed value equals original, remove that key from the patch
          if (action === DATA_ACTIONS.update) {
            const tableKey = `${tabId}.${tableWindow.table.schema}.${tableWindow.table.name}`;
            let original: Record<string, any> | undefined;

            if (dataKey === DATA_KEYS.data) {
              const rowIndex = parseInt(rowKey, 10);
              if (!isNaN(rowIndex) && rowIndex >= 0) {
                const cache = s.tableRowCacheByKey[tableKey];
                const originalRow = cacheGet(cache, rowIndex) as
                  | unknown[]
                  | undefined;
                const columns = tableData.columns ?? [];
                if (
                  originalRow &&
                  Array.isArray(originalRow) &&
                  columns.length
                ) {
                  original = {};
                  for (let i = 0; i < columns.length; i++) {
                    const col = columns[i];
                    if (col?.name) original[col.name] = originalRow[i];
                  }
                }
              }
            } else if (dataKey === DATA_KEYS.structure) {
              const rowIndex = parseInt(rowKey, 10);
              if (!isNaN(rowIndex) && rowIndex >= 0) {
                const meta = s.tableDataMap[tableKey];
                const structure = meta?.structure;
                original = structure?.[rowIndex] as
                  | Record<string, any>
                  | undefined;
              }
            } else if (dataKey === DATA_KEYS.constraints) {
              const rowIndex = parseInt(rowKey, 10);
              if (!isNaN(rowIndex) && rowIndex >= 0) {
                const meta = s.tableDataMap[tableKey];
                const constraints = meta?.constraints;
                original = constraints?.[rowIndex] as
                  | Record<string, any>
                  | undefined;
              }
            }

            if (original) {
              const cleaned: Record<string, any> = {};
              for (const [key, value] of Object.entries(dataToWrite)) {
                if (key === "__rowKey") {
                  cleaned[key] = value;
                  continue;
                }
                let origVal = original[key];
                if (dataKey === DATA_KEYS.structure && key === "foreign_key") {
                  const rowColumn =
                    typeof original.column_name === "string"
                      ? original.column_name.trim()
                      : "";
                  if ((cellToString(origVal) ?? "") === "" && rowColumn) {
                    const meta = s.tableDataMap[tableKey];
                    const existingFk =
                      meta?.foreignKeys?.find((fk) =>
                        fk.column_names
                          .split(",")
                          .map((x) => x.trim())
                          .includes(rowColumn)
                      ) ?? null;
                    if (
                      existingFk?.ref_table_name &&
                      existingFk?.ref_column_names
                    ) {
                      origVal = `${existingFk.ref_table_name}(${existingFk.ref_column_names})`;
                    }
                  }
                }
                const patchStr = cellToString(value);
                const origStr = cellToString(origVal);
                if (patchStr !== origStr) cleaned[key] = value;
              }
              dataToWrite = cleaned;
            }
          }

          const windowData = s.dataPatchMap[tabId]?.[tableWindowId];
          const patches = windowData?.patches ?? {};
          const actionPatches = patches[action] ?? {};
          const dataKeyPatches = actionPatches[dataKey] ?? {};

          // If no keys left to write, remove this row from the patch.
          // NOTE: For `delete` actions we still need an entry (the key itself
          // is the information), so we only prune empty data for non-delete
          // actions (primarily `update`).
          if (
            action !== DATA_ACTIONS.delete &&
            Object.keys(dataToWrite).length === 0
          ) {
            if (!windowData?.patches?.[action]?.[dataKey]?.[rowKey]) return s;
            const nextPatches = { ...patches };
            const nextAction = { ...actionPatches };
            const nextDataKey = { ...dataKeyPatches };
            delete nextDataKey[rowKey];
            if (Object.keys(nextDataKey).length === 0) {
              delete nextAction[dataKey];
              if (Object.keys(nextAction).length === 0)
                delete nextPatches[action];
              else nextPatches[action] = nextAction;
            } else
              nextPatches[action] = { ...nextAction, [dataKey]: nextDataKey };
            const cleanedPatches =
              Object.keys(nextPatches).length > 0 ? nextPatches : {};
            return {
              dataPatchMap: {
                ...s.dataPatchMap,
                [tabId]: {
                  ...(s.dataPatchMap[tabId] ?? {}),
                  [tableWindowId]: {
                    ...windowData!,
                    patches: cleanedPatches,
                  },
                },
              },
            };
          }

          return {
            dataPatchMap: {
              ...s.dataPatchMap,
              [tabId]: {
                ...(s.dataPatchMap[tabId] ?? {}),
                [tableWindowId]: {
                  tableData,
                  tableWindow,
                  patches: {
                    ...patches,
                    [action]: {
                      ...actionPatches,
                      [dataKey]: {
                        ...dataKeyPatches,
                        [rowKey]: dataToWrite,
                      },
                    },
                  },
                },
              },
            },
          };
        });
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

      resetRows: (key) =>
        set((s) => {
          if (!s.tableRowCacheByKey[key] && !s.tableRowsByKey[key]) return s;
          return {
            tableRowsByKey: {
              ...s.tableRowsByKey,
              [key]: {
                ...s.tableRowsByKey[key],
                rows: Array.from(s.tableRowCacheByKey[key]?.map),
              },
            },
          };
        }),

      beginRowsStream: (key, opId, cap, streamOffset = 0, resetCache = false) =>
        set((s) => {
          // --- UPDATED: Handle cache reset ---
          let currentCache = s.tableRowCacheByKey;
          if (resetCache) {
            const { [key]: _, ...rest } = s.tableRowCacheByKey;
            currentCache = rest;
          }

          const prev =
            s.tableRowsByKey[key] ?? makeRowsState(cap ?? DEFAULT_ROWS_CAP);

          const nextCap = cap ? Math.max(200, Math.floor(cap)) : prev.cap;
          const nextStreamOffset = clampNonNeg(streamOffset);

          // Get cache for this specific key (might be undefined if we just reset it)
          const cacheEntry = currentCache[key];

          // Soft refresh window buffer:
          // - Same streamOffset + same cap + !resetCache: keep prev.rows
          // - Otherwise: allocate new window and hydrate from overlap + cache
          let nextRows: (unknown[] | undefined)[];

          const sameCap = prev.cap === nextCap;
          const sameStream = prev.streamOffset === nextStreamOffset;

          // If resetCache is true, we must assume prev.rows contains stale data (e.g. from previous sort order),
          // so we force a fresh start (no overlap reuse).
          const forceFresh = resetCache;

          if (!forceFresh && sameCap && sameStream) {
            nextRows = prev.rows;
          } else {
            nextRows = new Array(nextCap).fill(undefined);

            // Only copy overlap if we are NOT forcing a fresh start
            if (!forceFresh) {
              const prevBase = prev.base;
              const prevEnd = prev.base + prev.cap;

              const newBase = nextStreamOffset; // align base to streamOffset
              const newEnd = newBase + nextCap;

              const overlapStart = Math.max(prevBase, newBase);
              const overlapEnd = Math.min(prevEnd, newEnd);

              if (overlapEnd > overlapStart) {
                const len = overlapEnd - overlapStart;
                const srcOff = overlapStart - prevBase;
                const dstOff = overlapStart - newBase;
                for (let i = 0; i < len; i++) {
                  nextRows[dstOff + i] = prev.rows[srcOff + i];
                }
              }
            }

            // Hydrate from cache for instant render (if cache exists)
            if (cacheEntry) {
              const newBase = nextStreamOffset;
              for (let i = 0; i < nextCap; i++) {
                if (nextRows[i] !== undefined) continue;
                const globalIdx = newBase + i;
                const cached = cacheGet(cacheEntry, globalIdx);
                if (cached !== undefined) nextRows[i] = cached;
              }
            }
          }

          const next: TableRowState = {
            ...prev,
            opId,

            cap: nextCap,
            base: nextStreamOffset,
            streamOffset: nextStreamOffset,

            rows: nextRows,

            // If resetting cache, ensure loadedMax is reset so UI doesn't think we have data
            loadedMax: forceFresh
              ? nextStreamOffset - 1
              : Math.max(prev.loadedMax, nextStreamOffset - 1),

            running: true,
            error: null,
            truncated: false,

            startedAt: Date.now(),
            lastChunkAt: prev.lastChunkAt,
            version: prev.version,
          };

          // Schedule 1/frame notify
          raf(() => scheduleRowsNotify(key));

          return {
            tableRowsByKey: {
              ...s.tableRowsByKey,
              [key]: next,
            },
            tableRowCacheByKey: currentCache,
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

          const wasEmpty = prev.loadedMax < prev.streamOffset; // chưa có row nào
          const nowHasAny = loadedMax >= prev.streamOffset;

          if (
            (wasEmpty && nowHasAny) ||
            touched > 0 ||
            loadedMax > prev.loadedMax
          ) {
            scheduleRowsNotify(key, { immediate: wasEmpty && nowHasAny });
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

      updateRow: (key, rowIndex, row) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev) return s;

          const idx = clampNonNeg(rowIndex);
          const base = prev.base;
          const cap = prev.cap;

          // Check if row is within current window
          if (idx < base || idx >= base + cap) return s;

          // Update the row in the window
          const windowIndex = idx - base;
          const newRows = [...prev.rows];
          newRows[windowIndex] = row;

          return {
            tableRowsByKey: {
              ...s.tableRowsByKey,
              [key]: { ...prev, rows: newRows },
            },
          };
        }),

      addRow: (key, row) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev) return s;

          const newGlobalIndex = prev.loadedMax + 1;

          // --- update window if visible ---
          let rows = prev.rows;
          if (
            newGlobalIndex >= prev.base &&
            newGlobalIndex < prev.base + prev.cap
          ) {
            const localIndex = newGlobalIndex - prev.base;
            rows = [...prev.rows];
            rows[localIndex] = row;
          }

          const next = {
            ...prev,
            rows,
            loadedMax: newGlobalIndex,
            version: prev.version + 1, // 🔥 important
          };

          return {
            tableRowsByKey: {
              ...s.tableRowsByKey,
              [key]: next,
            },
          };
        }),

      removeRow: (key, globalRowIndex) =>
        set((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev) return s;
          // Only support removing the last added row (unsaved new row)
          if (
            globalRowIndex !== prev.loadedMax ||
            prev.loadedMax < prev.streamOffset
          )
            return s;

          const nextLoadedMax = prev.loadedMax - 1;
          let rows = prev.rows;
          if (
            globalRowIndex >= prev.base &&
            globalRowIndex < prev.base + prev.cap
          ) {
            const localIndex = globalRowIndex - prev.base;
            rows = [...prev.rows];
            rows[localIndex] = undefined;
          }

          const next = {
            ...prev,
            rows,
            loadedMax: nextLoadedMax,
            version: prev.version + 1,
          };

          return {
            tableRowsByKey: {
              ...s.tableRowsByKey,
              [key]: next,
            },
          };
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

      setTableFilter: (key, filter) =>
        set((s) => ({
          tableFilterByKey: { ...s.tableFilterByKey, [key]: filter },
        })),

      clearTableFilter: (key, visible = true) =>
        set((s) => ({
          tableFilterByKey: {
            ...s.tableFilterByKey,
            [key]: {
              ...s.tableFilterByKey[key],
              appliedFilters: [],
              appliedFilterCombine: "AND",
              filterBarVisible: visible,
            },
          },
        })),
    };
  })
);
