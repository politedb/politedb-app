import { create } from "zustand";
import { TableData, TableItem, TableSizeInfo } from "../types";

type SchemaState = {
  data: string[];
  busy: boolean;
  error: string | null;
};

type TableState = {
  data: TableItem[];
  busy: boolean;
  error: string | null;
};

type TableDataState = {
  data: TableData | null;
  sizeInfo: TableSizeInfo | null;
  connectionId: string | null;
  busy: boolean;
  error: string | null;
} | null;

type ConnectionState = {
  tables: Record<string, TableState>;
  schemas: Record<string, SchemaState>;
  tableDataMap: Record<string, TableDataState>;
  setTables: (schema: string, tables: TableState) => void;
  setSchemas: (schema: string, schemas: SchemaState) => void;
  addTableDataMap: (key: string, tableData: TableDataState) => void;
  removeTableDataMap: (key: string) => void;
};

export const useConnectionStore = create<ConnectionState>((set) => ({
  tables: {},
  tableDataMap: {},
  schemas: {},

  setSchemas: (schema: string, data: SchemaState) =>
    set((s) => ({
      schemas: {
        ...s.schemas,
        [schema]: data,
      },
    })),

  setTables: (key: string, data: TableState) =>
    set((s) => ({
      tables: {
        ...s.tables,
        [key]: data,
      },
    })),

  addTableDataMap: (key: string, tableData: TableDataState) =>
    set((s) => ({
      tableDataMap: {
        ...s.tableDataMap,
        [key]: tableData,
      },
    })),

  removeTableDataMap: (key: string) =>
    set((s) => ({
      tableDataMap: { ...s.tableDataMap, [key]: null },
    })),
}));
