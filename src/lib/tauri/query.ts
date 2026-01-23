import {
  ColumnMeta,
  operationExecute,
  operationCancel,
  QueryResult,
  TableChunk,
} from "src/lib/tauri";
import { toErrorMessage } from "./queryValidate";
import { operationBus } from "./operationBus";

type RunSqlOptions = {
  batchSize?: number;
  maxRows?: number;
  timeoutMs?: number;
};

function normalizeDoneColumns(done: any): ColumnMeta[] {
  const cols = done?.columns ?? [];
  if (!Array.isArray(cols)) return [];
  return cols.map((c: any) => ({
    name: String(c?.name ?? ""),
    db_type: String(c?.db_type ?? ""),
  }));
}

export async function runSqlQuery(
  connection_id: string,
  sql: string,
  opts?: RunSqlOptions
): Promise<QueryResult> {
  const opId = await operationExecute({
    connection_id,
    kind: "sql_query",
    sql: {
      sql,
      batch_size: opts?.batchSize ?? 100,
      max_rows: opts?.maxRows,
    },
  });

  // buffer by absolute index (row_offset-safe)
  const buffer: any[] = [];
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  return new Promise<QueryResult>(async (resolve, reject) => {
    let finished = false;
    let unsub: (() => void) | null = null;
    let timerId: number | null = null;

    const cleanup = () => {
      try {
        unsub?.();
      } catch {}
      unsub = null;

      if (timerId) window.clearTimeout(timerId);
      timerId = null;
    };

    const finalizeOk = (done: any) => {
      if (finished) return;
      finished = true;
      cleanup();

      const columns = normalizeDoneColumns(done);

      // remove holes if any
      const rows = buffer.filter((r) => r !== undefined);

      resolve({
        columns,
        rows,
        rowCount: done?.row_count ?? rows.length,
      });
    };

    const finalizeErr = (err: any) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(toErrorMessage(err)));
    };

    if (timeoutMs > 0) {
      timerId = window.setTimeout(async () => {
        if (finished) return;
        finished = true;

        cleanup();

        try {
          await operationCancel(opId);
        } catch {}

        reject(new Error("SQL_QUERY_TIMEOUT"));
      }, timeoutMs);
    }

    try {
      unsub = await operationBus.subscribe(opId, {
        onChunk: (chunk: TableChunk) => {
          if (finished) return;

          const rows = chunk.rows ?? [];
          if (!rows.length) return;

          const off = Number(chunk.row_offset ?? buffer.length);

          if (buffer.length < off) buffer.length = off;
          for (let i = 0; i < rows.length; i++) {
            buffer[off + i] = rows[i];
          }
        },

        onDone: (done: any) => {
          finalizeOk(done);
        },

        onError: (err: any) => {
          finalizeErr(err);
        },
      });
    } catch (e) {
      finalizeErr(e);
    }
  });
}

export async function startSqlQueryStream(
  connection_id: string,
  sql: string,
  opts?: RunSqlOptions
): Promise<string> {
  const opId = await operationExecute({
    connection_id,
    kind: "sql_query",
    sql: {
      sql,
      batch_size: opts?.batchSize ?? 100,
      max_rows: opts?.maxRows,
    },
  });
  return opId;
}
