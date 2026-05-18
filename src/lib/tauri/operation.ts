import { invoke } from "@tauri-apps/api/core";
import type { ColumnMeta, OperationExecuteInput } from "./types";
import { CMD } from "./commands";
import type { DatabaseEngine } from "src/types";

/* ============================================================================
 * Operations (runtime)
 * ============================================================================
 */

export async function operationExecute(
  input: OperationExecuteInput
): Promise<string> {
  return invoke<string>(CMD.operationExecute, { input });
}

export async function operationCancel(opId: string): Promise<void> {
  await invoke(CMD.operationCancel, { op_id: opId });
}

export async function operationExecuteTransaction(args: {
  connectionId: string;
  statements: string[];
}): Promise<void> {
  await invoke(CMD.operationExecuteTransaction, {
    input: {
      connection_id: args.connectionId,
      statements: args.statements,
    },
  });
}

export async function operationImportCsvTransaction(args: {
  connectionId: string;
  engine?: DatabaseEngine;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  columnMapping: Record<string, number | null>;
  nullMode: "empty-string" | "empty-as-null";
  firstIsHeaders: boolean;
  fullValidation: boolean;
  csvText: string;
}): Promise<{ imported: number }> {
  return invoke<{ imported: number }>(CMD.operationImportCsvTransaction, {
    input: {
      connection_id: args.connectionId,
      engine: args.engine ?? "postgres",
      schema: args.schema,
      table_name: args.tableName,
      columns: args.columns,
      column_mapping: args.columnMapping,
      null_mode: args.nullMode,
      first_is_headers: args.firstIsHeaders,
      full_validation: args.fullValidation,
      csv_text: args.csvText,
    },
  });
}

/* Convenience helper for SQL query */
export async function runQuery(
  connectionId: string,
  sql: string,
  opts?: { batchSize?: number; maxRows?: number }
): Promise<string> {
  const input: OperationExecuteInput = {
    connection_id: connectionId,
    kind: "sql_query",
    sql: {
      sql,
      batch_size: opts?.batchSize ?? 500,
      max_rows: opts?.maxRows ?? 50_000,
    },
  };
  return operationExecute(input);
}
