import type {
  ForeignKeyInfo,
  SqlQuery,
  TableColumn,
  TableConstraint,
  TableItem,
  TableSizeInfo,
  TableStructure,
  TableWindow,
} from "src/types";
import type { ColumnMeta, QueryResult } from "src/lib/tauri/types";
import type { PatchMap, VirtualKeySafetyIssue } from "src/lib/patches/generateSql";
import type { TableFilterCondition } from "src/lib/queries/sql";

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
  rowCountIsEstimated?: boolean;
  connectionId: string | null;
  busy: boolean;
  error: string | null;
};

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
  filterApplySeq?: number;
};

export type SelectedRowField = {
  name: string;
  value: string;
  dataType?: string;
  isNull?: boolean;
  readonly?: boolean;
};

export type SelectedRowDetail = {
  rowIndex: number;
  fields: SelectedRowField[];
};

export type RowFieldEditHandler = (
  rowIndex: number,
  columnName: string,
  newValue: string
) => void;

export type TableRowState = {
  opId?: string;
  base: number;
  cap: number;
  rows: (unknown[] | undefined)[];

  streamOffset: number;

  viewportStart: number;
  viewportEnd: number;

  loadedMax: number;
  running: boolean;
  error: string | null;
  truncated: boolean;

  version: number;

  startedAt?: number;
  lastChunkAt?: number;
  receivedAnyChunk?: boolean;
};

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
  virtualKeySafetyByKey: Record<string, VirtualKeySafetyIssue[]>;
  newTableData: Record<string, Record<string, NewTableDataState>>;
  tableFilterByKey: Record<string, TableFilterState>;

  tableRowsByKey: Record<string, TableRowState>;
  tableRowCacheByKey: Record<
    string,
    { map: Map<number, unknown[]>; order: number[] }
  >;
  selectedRowByKey: Record<string, SelectedRowDetail | null>;
  rowFieldEditHandlerByKey: Record<string, RowFieldEditHandler | undefined>;

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

  setSelectedRowDetail: (key: string, detail: SelectedRowDetail | null) => void;
  clearSelectedRowDetail: (key: string) => void;
  registerRowFieldEditHandler: (
    key: string,
    handler: RowFieldEditHandler | undefined
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
  setVirtualKeySafety: (key: string, issues: VirtualKeySafetyIssue[]) => void;
  clearVirtualKeySafety: (key: string) => void;

  setNewTableData: (
    tabId: string,
    tableWindowId: string,
    data: NewTableDataState
  ) => void;
  clearNewTableData: (tabId: string, tableWindowId?: string) => void;

  initRows: (key: string, cap?: number) => void;
  clearRows: (key: string) => void;
  resetRows: (key: string) => void;

  beginRowsStream: (
    key: string,
    opId: string,
    cap?: number,
    streamOffset?: number,
    resetCache?: boolean,
    forceRefresh?: boolean
  ) => void;

  endRowsStream: (key: string, opId: string) => void;
  failRowsStream: (key: string, opId: string, error: string) => void;

  setViewport: (key: string, start: number, end: number) => void;
  shiftWindowToViewport: (key: string) => void;

  applyRowsChunk: (key: string, opId: string, chunk: any) => void;

  getRowAt: (key: string, rowIndex: number) => unknown[] | undefined;
  getOriginalRowAt: (key: string, rowIndex: number) => unknown[] | undefined;
  getRowsWindowInfo: (key: string) => TableRowState | null;

  updateRow: (key: string, rowIndex: number, row: unknown[]) => void;
  addRow: (key: string, row: unknown[], insertAfterIndex?: number) => void;
  removeRow: (key: string, globalRowIndex: number) => void;
};
