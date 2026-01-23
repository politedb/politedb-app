import type { JSX } from "preact";
import { ColumnMeta } from "./lib/tauri";

export type NavId = "connections" | "keychain";
export type ViewMode = "grid" | "list";
export type TabViewMode = "left" | "right" | "bottom";
export type WindowType = "table" | "sql" | "explain" | "erd";

export type SqlQuery = {
  sql: string;
  timestamp: Date;
};

export type NavItem = {
  id: NavId;
  label: string;
  icon: JSX.Element;
};

export type TableItem = {
  schema: string;
  name: string;
  new?: boolean;
  kind?: "table" | "view";
};

export type OpenTable = {
  id: string;
  table: TableItem;
};

export type OpenWindowBase = {
  id: string;
  type: WindowType;
  connectionId?: string;
};

export type TableWindow = OpenWindowBase & {
  type: "table";
  table: TableItem;
};

export type SqlEditorWindow = OpenWindowBase & {
  type: "sql";
  title?: string; // "Query 1", "Untitled SQL", ...
  content: string; // SQL text
  lastRunAt?: number;
};

export type OpenWindow = TableWindow | SqlEditorWindow;

export type TableData = {
  columns: ColumnMeta[];
  rows: any[][];
  rowCount: number;
};

export type DatabaseEngine =
  | "postgres"
  | "mysql"
  | "redis"
  | "mariadb"
  | "sqlserver"
  | "mongo"
  | "sqlite"
  | "oracle";

export type DatabaseType = {
  engine: DatabaseEngine;
  label: string;
  abbreviation: string;
  color: string;
  available: boolean;
};

export type TableSizeInfo = {
  totalSize: string;
  dataSize: string;
  indexSize: string;
};

export type TableStructure = {
  column_name: string;
  data_type: string;
  is_nullable: boolean | string;
  check: string;
  column_default: string;
  foreign_key: string;
  comment: string;
  isNew?: boolean;
};

export type TableConstraint = {
  index_name: string;
  index_algorithm: string;
  is_unique: boolean | string;
  column_name: string;
  condition: string;
  include: string;
  comment: string;
  isNew?: boolean;
};

export type TableColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string; // "NULL" | "NOT NULL"
  column_default: string;
};

export type Pagination = {
  startIndex: number;
  endIndex: number;
  totalRows: number;
  totalPages: number;
};
