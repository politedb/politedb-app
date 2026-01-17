import { create } from "zustand";
import {
  TableData,
  TableItem,
  TableSizeInfo,
  TableRelationships,
  TableStructure,
  SqlQuery,
} from "src/types";
import type { ColumnMeta, QueryResult } from "src/lib/tauri/types";

type SchemaState = {
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

type TableState = {
  data: TableItem[];
  busy: boolean;
  error: string | null;
};

type TableDataState = {
  data: TableData | null;
  structure: TableStructure[] | null;
  relationships: TableRelationships[] | null;
  sizeInfo: TableSizeInfo | null;
  connectionId: string | null; // profile / DB connection
  busy: boolean;
  error: string | null;
};

type ConnectionState = {
  // key = windowId
  tables: Record<string, TableState>;
  schemas: Record<string, SchemaState>;
  queryHistory: Record<string, SqlQuery[]>;

  // cache key = `${connectionId}.${schema}.${table}`
  columnsCache: Record<string, ColumnMeta[]>;
  sizeInfoCache: Record<string, TableSizeInfo>;

  // key = windowId
  tableDataMap: Record<string, TableDataState>;
  sqlResults: Record<string, SqlResultState>;

  addQueryHistory: (tabId: string, query: SqlQuery) => void;
  clearQueryHistory: (tabId: string) => void;

  setSqlResult: (windowId: string, patch: Partial<SqlResultState>) => void;
  clearSqlResult: (windowId: string) => void;

  setTables: (windowId: string, data: TableState) => void;
  setSchemas: (tabIwindowId: string, data: SchemaState) => void;

  addTableDataMap: (windowId: string, data: TableDataState) => void;
  removeTableDataMap: (windowId: string) => void;

  setColumnsCache: (key: string, cols: ColumnMeta[]) => void;
  setSizeInfoCache: (key: string, info: TableSizeInfo) => void;
};
export const useConnectionStore = create<ConnectionState>((set) => ({
  tables: {},
  schemas: {},
  tableDataMap: {},
  sqlResults: {},
  queryHistory: {},

  columnsCache: {},
  sizeInfoCache: {},

  setSqlResult: (windowId, patch) =>
    set((s) => {
      const prev = s.sqlResults[windowId] ?? {
        busy: false,
        error: null,
        result: null,
      };

      const next = { ...prev, ...patch };

      // avoid useless rerender
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

  setTables: (windowId, data) =>
    set((s) => ({
      tables: {
        ...s.tables,
        [windowId]: data,
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

  addQueryHistory: (tabId: string, query: SqlQuery) =>
    set((s) => ({
      queryHistory: {
        ...s.queryHistory,
        [tabId]: [...(s.queryHistory[tabId] || []), query],
      },
    })),

  clearQueryHistory: (tabId: string) =>
    set((s) => ({
      queryHistory: {
        ...s.queryHistory,
        [tabId]: [],
      },
    })),
}));
