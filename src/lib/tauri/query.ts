import {
  ColumnMeta,
  operationExecute,
  operationCancel,
  QueryResult,
  TableChunk,
} from "src/lib/tauri";
import { detectSqlKind, trackEvent } from "src/lib/analytics";
import { toErrorMessage } from "./queryValidate";
import { operationBus } from "./operationBus";

type RunSqlOptions = {
  batchSize?: number;
  maxRows?: number;
  timeoutMs?: number;
};

const SQL_BUSY_RETRY_MAX = 8;
const SQL_BUSY_RETRY_BASE_MS = 80;
const SQL_BUSY_RETRY_CAP_MS = 1_000;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isSqlBusyError(err: unknown): boolean {
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err ?? "");
  return msg.includes("ERR_SQL_BUSY");
}

async function operationExecuteWithBusyRetry(
  payload: Parameters<typeof operationExecute>[0]
) {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= SQL_BUSY_RETRY_MAX; attempt++) {
    try {
      return await operationExecute(payload);
    } catch (err) {
      lastErr = err;
      if (!isSqlBusyError(err) || attempt >= SQL_BUSY_RETRY_MAX) {
        throw err;
      }

      const delay = Math.min(
        SQL_BUSY_RETRY_BASE_MS * Math.pow(2, attempt),
        SQL_BUSY_RETRY_CAP_MS
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}

function normalizeDoneColumns(done: any): ColumnMeta[] {
  const cols = done?.columns ?? [];
  if (!Array.isArray(cols)) return [];
  return cols.map((c: any) => ({
    name: String(c?.name ?? ""),
    db_type: String(c?.db_type ?? ""),
  }));
}

function safeRowOffset(chunk: TableChunk, fallback: number) {
  const raw = (chunk as any)?.row_offset;
  const off = Number(raw);
  if (Number.isFinite(off) && off >= 0) return off;
  return fallback;
}

export async function runSqlQuery(
  connection_id: string,
  sql: string,
  opts?: RunSqlOptions
): Promise<QueryResult> {
  const startedAt = Date.now();
  const sqlKind = detectSqlKind(sql);

  // Ensure operationBus listeners are attached before the backend starts emitting.
  await operationBus.ensureInit();

  const opId = await operationExecuteWithBusyRetry({
    connection_id,
    kind: "sql_query",
    sql: {
      sql,
      batch_size: opts?.batchSize ?? 100,
      max_rows: opts?.maxRows,
      client_mode: "direct",
    },
  });

  // buffer by absolute index (row_offset-safe)
  const buffer: any[] = [];
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  let finished = false;
  let unsub: (() => void) | null = null;
  let timerId: number | null = null;

  const cleanup = () => {
    try {
      unsub?.();
    } catch {}
    unsub = null;

    if (timerId != null) window.clearTimeout(timerId);
    timerId = null;
  };

  const finalizeOk = (done: any, resolve: (v: QueryResult) => void) => {
    if (finished) return;
    finished = true;
    cleanup();

    const columns = normalizeDoneColumns(done);
    const rows = buffer.filter((r) => r !== undefined);

    resolve({
      columns,
      rows,
      rowCount: done?.row_count ?? rows.length,
    });

    trackEvent("sql_query_success", {
      sql_kind: sqlKind,
      sql_length: sql.length,
      duration_ms: Date.now() - startedAt,
      row_count: Number(done?.row_count ?? rows.length),
    });
  };

  const finalizeErr = (err: any, reject: (e: Error) => void) => {
    if (finished) return;
    finished = true;
    cleanup();
    const message = toErrorMessage(err);
    trackEvent("sql_query_error", {
      sql_kind: sqlKind,
      sql_length: sql.length,
      duration_ms: Date.now() - startedAt,
      error: message.slice(0, 240),
    });
    reject(new Error(message));
  };

  return await new Promise<QueryResult>(async (resolve, reject) => {
    if (timeoutMs > 0) {
      timerId = window.setTimeout(async () => {
        if (finished) return;
        finished = true;

        cleanup();

        try {
          await operationCancel(opId);
        } catch {}

        trackEvent("sql_query_timeout", {
          sql_kind: sqlKind,
          sql_length: sql.length,
          duration_ms: Date.now() - startedAt,
          timeout_ms: timeoutMs,
        });
        reject(new Error("SQL_QUERY_TIMEOUT"));
      }, timeoutMs);
    }

    try {
      unsub = await operationBus.subscribe(opId, {
        onChunk: (chunk: TableChunk) => {
          if (finished) return;

          const rows = chunk.rows ?? [];
          if (!rows.length) return;

          const off = safeRowOffset(chunk, buffer.length);

          if (buffer.length < off) buffer.length = off;
          for (let i = 0; i < rows.length; i++) {
            buffer[off + i] = rows[i];
          }
        },
        onDone: (done: any) => finalizeOk(done, resolve),
        onError: (err: any) => finalizeErr(err, reject),
      });
    } catch (e) {
      finalizeErr(e, reject);
    }
  });
}

export async function startSqlQueryStream(
  connection_id: string,
  sql: string,
  opts?: RunSqlOptions
): Promise<string> {
  const startedAt = Date.now();
  const sqlKind = detectSqlKind(sql);

  // Ensure operationBus listeners are attached before the backend starts emitting.
  await operationBus.ensureInit();

  try {
    const opId = await operationExecuteWithBusyRetry({
      connection_id,
      kind: "sql_query",
      sql: {
        sql,
        batch_size: opts?.batchSize ?? 100,
        max_rows: opts?.maxRows,
        client_mode: "stream",
      },
    });
    trackEvent("sql_query_stream_start", {
      sql_kind: sqlKind,
      sql_length: sql.length,
      duration_ms: Date.now() - startedAt,
    });
    return opId;
  } catch (e: any) {
    trackEvent("sql_query_stream_error", {
      sql_kind: sqlKind,
      sql_length: sql.length,
      duration_ms: Date.now() - startedAt,
      error: String(e?.message ?? e ?? "").slice(0, 240),
    });
    throw e;
  }
}
