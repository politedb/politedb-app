import { create } from "zustand";
import type {
  TableData,
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

export type TableDataState = {
  data: TableData | null;
  structure: TableStructure[] | null;
  constraints: TableConstraint[] | null;
  sizeInfo: TableSizeInfo | null;
  connectionId: string | null; // profile / DB connection
  busy: boolean;
  error: string | null;
};

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

export type ConnectionState = {
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

  tableStructure: Record<string, Record<string, TableStructure[]>>;
  tableConstraints: Record<string, Record<string, TableConstraint[]>>;
  dataPatchMap: Record<string, PatchMap>;
  newTableData: Record<string, Record<string, NewTableDataState>>;

  addQueryHistory: (windowId: string, sql: string) => void;
  clearQueryHistory: (windowId: string) => void;

  setSqlResult: (windowId: string, patch: Partial<SqlResultState>) => void;
  clearSqlResult: (windowId: string) => void;

  setTables: (windowId: string, data: TableState) => void;
  addTable: (windowId: string, table: TableItem) => void;

  setSchemas: (tabIwindowId: string, data: SchemaState) => void;
  addSchema: (windowId: string, schema: string) => void;

  addTableDataMap: (windowId: string, data: TableDataState) => void;
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
};

export const useConnectionStore = create<ConnectionState>((set) => ({
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

  addSchema: (windowId, schema) =>
    set((s) => ({
      schemas: {
        ...s.schemas,
        [windowId]: {
          ...(s.schemas[windowId] || { data: [], busy: false, error: null }),
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
      if (!s.tableStructure[tabId]) {
        return s;
      }

      if (tableWindowId) {
        const { [tableWindowId]: _, ...rest } = s.tableStructure[tabId];
        return { tableStructure: { ...s.tableStructure, [tabId]: rest } };
      }

      return { tableStructure: { ...s.tableStructure, [tabId]: {} } };
    }),

  clearTableConstraints: (tabId, tableWindowId) =>
    set((s) => {
      if (!s.tableConstraints[tabId]) {
        return s;
      }

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
                ...(s.dataPatchMap[tabId]?.[tableWindowId]?.patches?.[action] ??
                  {}),
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
      if (!windowData?.patches?.[action]?.[dataKey]?.[rowKey]) {
        return s;
      }

      const patches = { ...windowData.patches };
      const actionPatches = { ...patches[action] };
      const dataKeyPatches = { ...actionPatches[dataKey] };
      const { [rowKey]: _, ...restDataKeyPatches } = dataKeyPatches;

      let finalPatches: typeof patches;

      // If no patches remain for this dataKey, remove it
      if (Object.keys(restDataKeyPatches).length === 0) {
        const { [dataKey]: _, ...restActionPatches } = actionPatches;
        // If no action patches remain, delete the action; otherwise keep the rest
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

      // Clean up empty patches object
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
      if (!s.dataPatchMap[tabId]) {
        return s;
      }

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
      if (!s.newTableData[tabId]) {
        return s;
      }

      if (tableWindowId) {
        const { [tableWindowId]: _, ...rest } = s.newTableData[tabId];
        return { newTableData: { ...s.newTableData, [tabId]: rest } };
      }

      return { newTableData: { ...s.newTableData, [tabId]: {} } };
    }),
}));
