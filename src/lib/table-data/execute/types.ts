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
  return {
    ...patch,
    connectionId: ctx.prev.connectionId ?? ctx.connId,
  };
}

export function asColumnRows(prev: any): ColumnRow[] {
  return Array.isArray(prev.columns) ? (prev.columns as ColumnRow[]) : [];
}
