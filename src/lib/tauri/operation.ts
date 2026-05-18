import { invoke } from "@tauri-apps/api/core";
import type { OperationExecuteInput } from "./types";
import { CMD } from "./commands";

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
