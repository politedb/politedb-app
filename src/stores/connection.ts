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
    screenId: string,
    tableWindowId: string,
    structure: TableStructure[]
  ) => void;

  updateTableStructure: (
    screenId: string,
    tableWindowId: string,
    rowIndex: number,
    field: keyof TableStructure,
    value: string | boolean
  ) => void;

  setTableConstraints: (
    screenId: string,
    tableWindowId: string,
    constraints: TableConstraint[]
  ) => void;

  updateTableConstraints: (
    screenId: string,
    tableWindowId: string,
    rowIndex: number,
    field: keyof TableConstraint,
    value: string | boolean
  ) => void;

  clearTableStructure: (screenId: string, tableWindowId?: string) => void;
  clearTableConstraints: (screenId: string, tableWindowId?: string) => void;

  setDataPatchMap: (screenId: string, props: DataPatchesState) => void;
  removeDataPatch: (
    screenId: string,
    tableWindowId: string,
    action: DataAction,
    dataKey: DataKey,
    rowKey: string
  ) => void;
  clearDataPatchMap: (screenId: string, tableWindowId?: string) => void;

  setNewTableData: (
    screenId: string,
    tableWindowId: string,
    data: NewTableDataState
  ) => void;
  clearNewTableData: (screenId: string, tableWindowId?: string) => void;
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

  setTableStructure: (screenId, tableWindowId, structure) =>
    set((s) => ({
      tableStructure: {
        ...s.tableStructure,
        [screenId]: {
          ...s.tableStructure[screenId],
          [tableWindowId]: structure,
        },
      },
    })),

  updateTableStructure: (screenId, tableWindowId, rowIndex, field, value) =>
    set((s) => {
      const structure = s.tableStructure[screenId]?.[tableWindowId] ?? [];
      structure[rowIndex] = { ...structure[rowIndex]!, [field]: value };
      return {
        tableStructure: {
          ...s.tableStructure,
          [screenId]: {
            ...s.tableStructure[screenId],
            [tableWindowId]: structure,
          },
        },
      };
    }),

  setTableConstraints: (screenId, tableWindowId, constraints) =>
    set((s) => ({
      tableConstraints: {
        ...s.tableConstraints,
        [screenId]: {
          ...s.tableConstraints[screenId],
          [tableWindowId]: constraints,
        },
      },
    })),

  updateTableConstraints: (screenId, tableWindowId, rowIndex, field, value) =>
    set((s) => {
      const constraints = s.tableConstraints[screenId]?.[tableWindowId] ?? [];
      constraints[rowIndex] = { ...constraints[rowIndex]!, [field]: value };
      return {
        tableConstraints: {
          ...s.tableConstraints,
          [screenId]: {
            ...s.tableConstraints[screenId],
            [tableWindowId]: constraints,
          },
        },
      };
    }),

  clearTableStructure: (screenId, tableWindowId) =>
    set((s) => {
      if (!s.tableStructure[screenId]) {
        return s;
      }

      if (tableWindowId) {
        const { [tableWindowId]: _, ...rest } = s.tableStructure[screenId];
        return { tableStructure: { ...s.tableStructure, [screenId]: rest } };
      }

      return { tableStructure: { ...s.tableStructure, [screenId]: {} } };
    }),

  clearTableConstraints: (screenId, tableWindowId) =>
    set((s) => {
      if (!s.tableConstraints[screenId]) {
        return s;
      }

      if (tableWindowId) {
        const { [tableWindowId]: _, ...rest } = s.tableConstraints[screenId];
        return {
          tableConstraints: { ...s.tableConstraints, [screenId]: rest },
        };
      }

      return { tableConstraints: { ...s.tableConstraints, [screenId]: {} } };
    }),

  setDataPatchMap: (screenId: string, props: DataPatchesState) => {
    const { dataKey, action, tableData, tableWindow, rowKey, data } = props;
    const tableWindowId = tableWindow.id;

    set((s) => ({
      dataPatchMap: {
        ...s.dataPatchMap,
        [screenId]: {
          ...(s.dataPatchMap[screenId] ?? {}),
          [tableWindowId]: {
            tableData,
            tableWindow,
            patches: {
              ...(s.dataPatchMap[screenId]?.[tableWindowId]?.patches ?? {}),
              [action]: {
                ...(s.dataPatchMap[screenId]?.[tableWindowId]?.patches?.[
                  action
                ] ?? {}),
                [dataKey]: {
                  ...(s.dataPatchMap[screenId]?.[tableWindowId]?.patches?.[
                    action
                  ]?.[dataKey] ?? {}),
                  [rowKey]: {
                    ...(s.dataPatchMap[screenId]?.[tableWindowId]?.patches?.[
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

  removeDataPatch: (screenId, tableWindowId, action, dataKey, rowKey) =>
    set((s) => {
      const windowData = s.dataPatchMap[screenId]?.[tableWindowId];
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
          [screenId]: {
            ...s.dataPatchMap[screenId],
            [tableWindowId]: {
              ...windowData,
              patches: cleanedPatches,
            },
          },
        },
      };
    }),

  clearDataPatchMap: (screenId, tableWindowId) =>
    set((s) => {
      if (!s.dataPatchMap[screenId]) {
        return s;
      }

      if (tableWindowId) {
        const { [tableWindowId]: _, ...rest } = s.dataPatchMap[screenId];
        return { dataPatchMap: { ...s.dataPatchMap, [screenId]: rest } };
      }

      const { [screenId]: _, ...rest } = s.dataPatchMap;
      return { dataPatchMap: rest };
    }),

  setNewTableData: (screenId, tableWindowId, data) =>
    set((s) => ({
      newTableData: {
        ...s.newTableData,
        [screenId]: {
          ...s.newTableData[screenId],
          [tableWindowId]: data,
        },
      },
    })),

  clearNewTableData: (screenId, tableWindowId) =>
    set((s) => {
      if (!s.newTableData[screenId]) {
        return s;
      }

      if (tableWindowId) {
        const { [tableWindowId]: _, ...rest } = s.newTableData[screenId];
        return { newTableData: { ...s.newTableData, [screenId]: rest } };
      }

      return { newTableData: { ...s.newTableData, [screenId]: {} } };
    }),
}));
