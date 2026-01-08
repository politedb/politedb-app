import type { JSX } from "preact";
import { ColumnMeta } from "./lib/tauri";

export type NavId = "connections" | "keychain";
export type ViewMode = "grid" | "list";
export type TabViewMode = "left" | "right" | "bottom";

export type SqlQuery = {
  id: string;
  sql: string;
  timestamp: Date;
  executionTime?: number;
};

export type NavItem = {
  id: NavId;
  label: string;
  icon: JSX.Element;
};

export type TableItem = { schema: string; name: string };

export type OpenTable = {
  id: string;
  table: TableItem;
};

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
