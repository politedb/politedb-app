import { listenOp, operationExecute, TableChunk } from "../lib/tauri";

type QueryResult = { rows: any; rowCount: number };

export function runSqlQuery(connection_id: string, sql: string) {
  return new Promise<QueryResult>(async (resolve, reject) => {
    try {
      const opId = await operationExecute({
        connection_id,
        kind: "sql_query",
        sql: { sql, batch_size: 200, max_rows: 50_000 },
      });

      const buffer: any[][] = [];

      const unsub = listenOp(
        opId,
        (chunk: TableChunk) => {
          const rows = chunk.rows || [];
          if (rows.length) buffer.push(...rows);
        },
        (done: any) => {
          unsub();
          resolve({ rows: buffer, rowCount: done?.row_count ?? buffer.length });
        },
        (err: any) => {
          unsub();
          reject(err);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}
