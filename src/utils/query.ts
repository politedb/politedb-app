import { listenOp, operationExecute, TableChunk } from "../lib/tauri";

type QueryResult = { rows: any[][]; rowCount: number };

export async function runSqlQuery(
  connection_id: string,
  sql: string
): Promise<QueryResult> {
  const opId = await operationExecute({
    connection_id,
    kind: "sql_query",
    sql: { sql, batch_size: 200, max_rows: 50_000 },
  });

  const buffer: any[][] = [];

  return await new Promise<QueryResult>((resolve, reject) => {
    let unsub: undefined | (() => void);
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        unsub?.();
      } catch {
        // ignore
      }
    };

    try {
      unsub = listenOp(
        opId,
        (chunk: TableChunk) => {
          const rows = chunk.rows ?? [];
          if (rows.length) buffer.push(...rows);
        },
        (done: any) => {
          cleanup();
          resolve({ rows: buffer, rowCount: done?.row_count ?? buffer.length });
        },
        (err: any) => {
          cleanup();
          reject(err);
        }
      );
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}
