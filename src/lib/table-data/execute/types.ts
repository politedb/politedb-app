import type { DatabaseEngine, TableSizeInfo } from "src/types";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { LoadFlags, LoadPlan, ColumnRow } from "../types";

export type LoadExecutionContext = {
  key: string;
  loadSignature: string;
  schema: string;
  tableName: string;
  connId: string;
  plan: LoadPlan;
  prev: any;
  flags: LoadFlags;
  limit: number;
  offset: number;
  engine: DatabaseEngine;
  profileId: string;
  /** False once this load may no longer publish (R5); rows are not written. */
  isCurrent?: () => boolean;
  /** The connection and tab epoch owning this load; streams never join another's. */
  owner?: string;
  /** The database / keyspace the tab was opened on instead of the profile's own. */
  databaseOverride?: string | null;
  supportsMeta: boolean;
  columnsCache: Record<string, ColumnMeta[] | undefined>;
  sizeInfoCache: Record<string, TableSizeInfo | undefined>;
  setMeta: (key: string, patch: any) => void;
  setColumnsCache: (key: string, cols: any) => void;
  setSizeInfoCache: (key: string, info: any) => void;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
};

export type LoadExecutionResult = "done" | "continue_sql";

export function patchWithConn(
  ctx: LoadExecutionContext,
  patch: Record<string, unknown>
) {
  // The connection this load ran on, never an older one (R4).
  return {
    ...patch,
    connectionId: ctx.connId,
  };
}

export function asColumnRows(prev: any): ColumnRow[] {
  return Array.isArray(prev.columns) ? (prev.columns as ColumnRow[]) : [];
}
