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

export type RunSqlOptions = {
  batchSize?: number;
  maxRows?: number;
  timeoutMs?: number;
  /**
   * Opt-in cancellation. Abort cancels only this helper's operation,
   * including ops created after abort was already requested (late creation).
   */
  signal?: AbortSignal;
  /**
   * Private internal execution: suppress analytics telemetry.
   * Callers must not route through SQL history / performance history.
   * Default false preserves existing caller behavior.
   */
  internal?: boolean;
  /**
   * Server-side limits, applied inside the statement's transaction. Engines
   * that do not support one ignore it. Without them the server defaults apply
   * (the client-side `timeoutMs` still cancels the operation).
   */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  readOnly?: boolean;
  /**
   * PostgreSQL: values in fixed text formats whatever the session settings
   * (ISO dates, ISO 8601 intervals, exact floats), for text that must read
   * back the same elsewhere (backups).
   */
  canonicalTextOutput?: boolean;
  /**
   * PostgreSQL: read this exported snapshot (sqlSessionBegin "snapshot"),
   * so separate queries see one database state.
   */
  snapshotId?: string;
};

const SQL_BUSY_RETRY_MAX = 8;
const SQL_BUSY_RETRY_BASE_MS = 80;
const SQL_BUSY_RETRY_CAP_MS = 1_000;

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createAbortError(): Error {
  try {
    return new DOMException("Aborted", "AbortError");
  } catch {
    const err = new Error("Aborted");
    err.name = "AbortError";
    return err;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    ((err as Error).name === "AbortError" ||
      (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "AbortError"))
  );
}

function sqlBusyErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "";
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error) return rec.error;
    if (typeof rec.message === "string" && rec.message) return rec.message;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return err == null ? "" : String(err);
}

function isSqlBusyError(err: unknown): boolean {
  return sqlBusyErrorMessage(err).includes("ERR_SQL_BUSY");
}

/** Extract the holding op id from `ERR_SQL_BUSY:<uuid>` when present. */
function parseSqlBusyOpId(err: unknown): string | null {
  const m = /ERR_SQL_BUSY:([0-9a-f-]{36})/i.exec(sqlBusyErrorMessage(err));
  return m?.[1] ?? null;
}

/** Reject as soon as `signal` aborts, without waiting for `promise` to settle. */
function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbortReject: () => unknown
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(onAbortReject());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(onAbortReject());
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      }
    );
  });
}

export async function operationExecuteWithBusyRetry(
  payload: Parameters<typeof operationExecute>[0],
  signal?: AbortSignal,
  isTimedOut?: () => boolean
) {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= SQL_BUSY_RETRY_MAX; attempt++) {
    if (signal?.aborted) {
      if (isTimedOut?.()) throw new Error("SQL_QUERY_TIMEOUT");
      throw createAbortError();
    }
    try {
      const execPromise = operationExecute(payload);
      // If abort/deadline settles before execute returns, still cancel the
      // late-created op when the IPC finally resolves.
      void execPromise.then(
        (id) => {
          if (signal?.aborted) {
            void operationCancel(id).catch(() => {});
          }
        },
        () => {}
      );
      const opId = await raceAgainstAbort(execPromise, signal, () =>
        isTimedOut?.() ? new Error("SQL_QUERY_TIMEOUT") : createAbortError()
      );
      if (signal?.aborted) {
        void operationCancel(opId).catch(() => {});
        if (isTimedOut?.()) throw new Error("SQL_QUERY_TIMEOUT");
        throw createAbortError();
      }
      return opId;
    } catch (err) {
      lastErr = err;
      if (
        isAbortError(err) ||
        (err instanceof Error && err.message === "SQL_QUERY_TIMEOUT")
      ) {
        throw err;
      }
      if (!isSqlBusyError(err) || attempt >= SQL_BUSY_RETRY_MAX) {
        throw err;
      }

      // Same connection still held by a prior stream (often a just-cancelled
      // export, or a grid/prefetch stream that snuck in after cancel released
      // sql_busy). Ask that op to stop, then retry ASAP.
      //
      // Backend cancel_operation calls release_op synchronously, so sleeping
      // here only widens the window for a competing stream (sqlLoader retry)
      // to re-acquire and starve re-export until retries exhaust.
      const busyOpId = parseSqlBusyOpId(err);
      if (busyOpId) {
        try {
          await operationCancel(busyOpId);
        } catch {
          /* ignore */
        }
        continue;
      }

      // No holder id in the error — brief backoff before retrying.
      const delay = Math.min(
        SQL_BUSY_RETRY_BASE_MS * Math.pow(2, attempt),
        SQL_BUSY_RETRY_CAP_MS
      );
      try {
        await sleep(delay, signal);
      } catch (sleepErr) {
        if (isTimedOut?.()) throw new Error("SQL_QUERY_TIMEOUT");
        throw sleepErr;
      }
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
  const internal = !!opts?.internal;
  const externalSignal = opts?.signal;
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  if (externalSignal?.aborted) {
    throw createAbortError();
  }

  // Deadline covers init, busy retries, execute, and result wait — not only
  // the post-subscribe phase. Abort/timeout settle independently of pending IPC.
  const localAc = new AbortController();
  let timedOut = false;
  let timerId: number | null = null;
  let opId: string | null = null;

  const isTimedOut = () => timedOut;
  const abortReason = () =>
    timedOut ? new Error("SQL_QUERY_TIMEOUT") : createAbortError();

  const requestCancel = () => {
    if (opId) {
      // Never await cancel — it must not block timeout/abort settlement.
      void operationCancel(opId).catch(() => {});
    }
  };

  const onLocalAbort = () => {
    requestCancel();
  };
  localAc.signal.addEventListener("abort", onLocalAbort);

  const onExternalAbort = () => {
    localAc.abort();
  };
  externalSignal?.addEventListener("abort", onExternalAbort);

  if (timeoutMs > 0) {
    timerId = window.setTimeout(() => {
      timedOut = true;
      localAc.abort();
    }, timeoutMs);
  }

  const signal = localAc.signal;

  const cleanupLifecycle = () => {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    localAc.signal.removeEventListener("abort", onLocalAbort);
    if (timerId != null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  try {
    await raceAgainstAbort(operationBus.ensureInit(), signal, abortReason);

    if (signal.aborted) throw abortReason();

    try {
      opId = await operationExecuteWithBusyRetry(
        {
          connection_id,
          kind: "sql_query",
          sql: {
            sql,
            batch_size: opts?.batchSize ?? 100,
            max_rows: opts?.maxRows,
            statement_timeout_ms: opts?.statementTimeoutMs,
            lock_timeout_ms: opts?.lockTimeoutMs,
            read_only: opts?.readOnly,
            snapshot_id: opts?.snapshotId,
            client_mode: "direct",
          },
        },
        signal,
        isTimedOut
      );
    } catch (err) {
      if (signal.aborted) throw abortReason();
      throw err;
    }

    // Late creation: abort/timeout arrived while execute was pending.
    if (signal.aborted) {
      requestCancel();
      throw abortReason();
    }

    const buffer: any[] = [];
    let finished = false;
    let unsub: (() => void) | null = null;
    let onAbortReject: (() => void) | null = null;

    const cleanup = () => {
      if (onAbortReject) signal.removeEventListener("abort", onAbortReject);
      onAbortReject = null;
      try {
        unsub?.();
      } catch {}
      unsub = null;
      cleanupLifecycle();
    };

    return await new Promise<QueryResult>(async (resolve, reject) => {
      const finalizeOk = (done: any) => {
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

        if (!internal) {
          trackEvent("sql_query_success", {
            sql_kind: sqlKind,
            sql_length: sql.length,
            duration_ms: Date.now() - startedAt,
            row_count: Number(done?.row_count ?? rows.length),
          });
        }
      };

      const finalizeErr = (err: any) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (
          timedOut ||
          (err instanceof Error && err.message === "SQL_QUERY_TIMEOUT")
        ) {
          // Timeout telemetry is emitted once in the outer catch (R5).
          reject(new Error("SQL_QUERY_TIMEOUT"));
          return;
        }
        if (isAbortError(err) || signal.aborted) {
          reject(createAbortError());
          return;
        }
        const message = toErrorMessage(err);
        if (!internal) {
          trackEvent("sql_query_error", {
            sql_kind: sqlKind,
            sql_length: sql.length,
            duration_ms: Date.now() - startedAt,
            error: message.slice(0, 240),
          });
        }
        reject(new Error(message));
      };

      onAbortReject = () => {
        requestCancel();
        finalizeErr(abortReason());
      };
      signal.addEventListener("abort", onAbortReject);

      if (signal.aborted) {
        finalizeErr(abortReason());
        return;
      }

      try {
        // Abort/timeout settle via onAbortReject without awaiting subscribe IPC.
        unsub = await operationBus.subscribe(opId!, {
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
          onDone: (done: any) => finalizeOk(done),
          onError: (err: any) => finalizeErr(err),
        });
        // R6: cancel/timeout may finalize before subscribe resolves; dispose late unsub.
        if (finished) {
          try {
            unsub?.();
          } catch {}
          unsub = null;
        }
      } catch (e) {
        finalizeErr(e);
      }
    });
  } catch (err) {
    cleanupLifecycle();
    if (
      timedOut ||
      (err instanceof Error && err.message === "SQL_QUERY_TIMEOUT")
    ) {
      if (!internal) {
        trackEvent("sql_query_timeout", {
          sql_kind: sqlKind,
          sql_length: sql.length,
          duration_ms: Date.now() - startedAt,
          timeout_ms: timeoutMs,
        });
      }
      throw new Error("SQL_QUERY_TIMEOUT");
    }
    if (isAbortError(err) || signal.aborted) {
      throw createAbortError();
    }
    throw err;
  }
}

export async function startSqlQueryStream(
  connection_id: string,
  sql: string,
  opts?: RunSqlOptions
): Promise<string> {
  const startedAt = Date.now();
  const sqlKind = detectSqlKind(sql);
  const internal = !!opts?.internal;
  const signal = opts?.signal;

  if (signal?.aborted) {
    throw createAbortError();
  }

  await operationBus.ensureInit();

  try {
    const opId = await operationExecuteWithBusyRetry(
      {
        connection_id,
        kind: "sql_query",
        sql: {
          sql,
          batch_size: opts?.batchSize ?? 100,
          max_rows: opts?.maxRows,
          client_mode: "stream",
          canonical_text_output: opts?.canonicalTextOutput,
          snapshot_id: opts?.snapshotId,
        },
      },
      signal
    );
    if (signal?.aborted) {
      try {
        await operationCancel(opId);
      } catch {}
      throw createAbortError();
    }
    if (!internal) {
      trackEvent("sql_query_stream_start", {
        sql_kind: sqlKind,
        sql_length: sql.length,
        duration_ms: Date.now() - startedAt,
      });
    }
    return opId;
  } catch (e: any) {
    if (isAbortError(e)) throw e;
    if (!internal) {
      trackEvent("sql_query_stream_error", {
        sql_kind: sqlKind,
        sql_length: sql.length,
        duration_ms: Date.now() - startedAt,
        error: String(e?.message ?? e ?? "").slice(0, 240),
      });
    }
    throw e;
  }
}
