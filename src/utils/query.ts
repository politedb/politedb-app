import { operationBus } from "../lib/tauri/operationBus";
import {
  ColumnMeta,
  operationExecute,
  operationCancel,
  QueryResult,
  TableChunk,
} from "../lib/tauri";

type RunSqlOptions = {
  batchSize?: number;
  maxRows?: number;
  timeoutMs?: number;
  // how long we wait for meta after done (ms)
  metaGraceMs?: number; // default 30
};

function normalizeColumns(meta: any): ColumnMeta[] {
  const cols = Array.isArray(meta)
    ? meta
    : (meta?.columns ?? meta?.meta?.columns ?? meta?.meta ?? []);
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
      batch_size: opts?.batchSize ?? 200,
      max_rows: opts?.maxRows ?? 50_000,
    },
  });

  const buffer: any[][] = [];
  let columns: ColumnMeta[] = [];

  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const metaGraceMs = opts?.metaGraceMs ?? 30;

  return new Promise<QueryResult>(async (resolve, reject) => {
    let finished = false;
    let unsub: (() => void) | null = null;

    let timerId: number | null = null;
    let metaWaitTimer: number | null = null;

    let metaReceived = false;
    let donePending: any | null = null;

    const cleanup = () => {
      try {
        unsub?.();
      } catch {}
      unsub = null;

      if (timerId) window.clearTimeout(timerId);
      timerId = null;

      if (metaWaitTimer) window.clearTimeout(metaWaitTimer);
      metaWaitTimer = null;
    };

    const finalizeOk = (done: any) => {
      if (finished) return;
      finished = true;
      cleanup();

      resolve({
        columns,
        rows: buffer,
        rowCount: done?.row_count ?? buffer.length,
      });
    };

    const finalizeErr = (err: any) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    };

    // timeout for whole query
    if (timeoutMs > 0) {
      timerId = window.setTimeout(async () => {
        if (finished) return;
        finished = true;

        // stop receiving first
        try {
          unsub?.();
        } catch {}
        unsub = null;

        try {
          await operationCancel(opId);
        } catch {}

        reject(new Error("SQL_QUERY_TIMEOUT"));
      }, timeoutMs);
    }

    try {
      unsub = await operationBus.subscribe(opId, {
        onMeta: (meta) => {
          if (finished) return;

          const next = normalizeColumns(meta);
          if (next.length) columns = next;
          metaReceived = true;

          // if done already arrived, resolve now
          if (donePending) {
            const d = donePending;
            donePending = null;
            finalizeOk(d);
          }
        },

        onChunk: (chunk: TableChunk) => {
          if (finished) return;
          if (chunk.rows?.length) buffer.push(...chunk.rows);
        },

        onDone: (done: any) => {
          if (finished) return;

          // If we already have meta (or query likely has no columns), resolve immediately
          if (metaReceived || columns.length > 0) {
            finalizeOk(done);
            return;
          }

          // Otherwise wait a tiny grace window for meta
          donePending = done;
          metaWaitTimer = window.setTimeout(() => {
            if (finished) return;
            if (!donePending) return;

            const d = donePending;
            donePending = null;
            finalizeOk(d);
          }, metaGraceMs);
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
