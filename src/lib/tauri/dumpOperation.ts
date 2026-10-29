import { operationBus } from "./operationBus";
import { operationCancel } from "./operation";
import { createAbortError, operationExecuteWithBusyRetry } from "./query";
import type { OperationDone, TableChunk } from "./types";

/**
 * An owned SQL operation for backups and restores: unlike runSqlQuery, its
 * owner learns when the client side is really finished with it (settled),
 * not only its result, and every way of stopping goes through one routine
 * that cancels the operation however far it got.
 *
 * - "server-finished": the operation's done/error event arrived and every
 *   chunk handler already running for it settled;
 * - "client-disposed": the owner stopped it first (cancel, timeout, a
 *   failed subscription or handler): its operation id, also a late one,
 *   was asked to cancel, the bus drops its later events, and handlers
 *   already running settled. Whether the server finished is unknown.
 *
 * Nothing here reports to analytics (dump SQL and errors stay private).
 */
export type DumpSettled = {
  kind: "server-finished" | "client-disposed";
  /** Why it ended when that was not a success. */
  error?: unknown;
};

/** What asking the backend to cancel the operation gave. */
export type DumpCancelAck =
  | { kind: "requested" }
  | { kind: "rejected"; error: unknown };

export type DumpOperation<T> = {
  result: Promise<T>;
  /** Stops the operation; resolves with the backend cancel's answer. */
  cancel(): Promise<DumpCancelAck>;
  settled: Promise<DumpSettled>;
};

export type DumpSqlOptions = {
  timeoutMs?: number;
  snapshotId?: string;
  canonicalTextOutput?: boolean;
  batchSize?: number;
  maxRows?: number;
};

type Mode = "direct" | "stream";

function start<T>(
  connectionId: string,
  sql: string,
  mode: Mode,
  opts: DumpSqlOptions,
  onChunk: ((chunk: TableChunk) => void | Promise<void>) | null,
  onDone: (done: OperationDone) => T
): DumpOperation<T> {
  let resolveResult!: (value: T) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  // The owner may never read the result (it awaits settled instead).
  result.catch(() => {});
  let resolveSettled!: (value: DumpSettled) => void;
  const settled = new Promise<DumpSettled>((res) => (resolveSettled = res));

  const executeAbort = new AbortController();
  let opId: string | null = null;
  let execute: Promise<string | null> | null = null;
  let unsubscribe: (() => void) | null = null;
  let subscribing: Promise<void> | null = null;
  const running = new Set<Promise<void>>();
  let stopping: Promise<DumpCancelAck> | null = null;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const drainHandlers = async () => {
    while (running.size) await Promise.allSettled([...running]);
  };

  /** The one way to stop: cancel whatever exists or arrives, then settle. */
  const dispose = (cause: unknown): Promise<DumpCancelAck> => {
    if (stopping) return stopping;
    if (finished) return Promise.resolve({ kind: "requested" });
    stopping = (async () => {
      clearTimer();
      executeAbort.abort();
      let ack: DumpCancelAck = { kind: "requested" };
      const cancelId = async (id: string) => {
        operationBus.invalidate(id);
        try {
          await operationCancel(id);
        } catch (error) {
          ack = { kind: "rejected", error };
        }
      };
      // A pending execute: adopt its id when it arrives and cancel that.
      const id = opId ?? (execute ? await execute.catch(() => null) : null);
      if (id) await cancelId(id);
      // A pending subscription: let it finish, then drop it.
      if (subscribing) await subscribing.catch(() => {});
      unsubscribe?.();
      unsubscribe = null;
      await drainHandlers();
      rejectResult(cause);
      resolveSettled({ kind: "client-disposed", error: cause });
      return ack;
    })();
    return stopping;
  };

  const finish = async (
    outcome: { ok: true; done: OperationDone } | { ok: false; error: unknown }
  ) => {
    if (stopping || finished) return;
    await drainHandlers();
    if (stopping || finished) return;
    finished = true;
    clearTimer();
    unsubscribe?.();
    unsubscribe = null;
    if (outcome.ok) {
      try {
        resolveResult(onDone(outcome.done));
      } catch (error) {
        rejectResult(error);
      }
      resolveSettled({ kind: "server-finished" });
    } else {
      const error = toError(outcome.error);
      rejectResult(error);
      resolveSettled({ kind: "server-finished", error });
    }
  };

  void (async () => {
    try {
      await operationBus.ensureInit();
    } catch (error) {
      // Nothing was dispatched.
      void dispose(error);
      return;
    }
    if (stopping) return;
    let executeError: unknown = null;
    execute = operationExecuteWithBusyRetry(
      {
        connection_id: connectionId,
        kind: "sql_query",
        sql: {
          sql,
          batch_size: opts.batchSize ?? 100,
          max_rows: opts.maxRows,
          client_mode: mode,
          canonical_text_output: opts.canonicalTextOutput,
          snapshot_id: opts.snapshotId,
        },
      },
      executeAbort.signal
    ).catch((error) => {
      executeError = error;
      return null;
    });
    const id = await execute;
    if (stopping) return; // dispose adopts and cancels the id.
    if (!id) {
      // Nothing was started (or nothing we got an id for).
      void dispose(toError(executeError));
      return;
    }
    opId = id;
    subscribing = (async () => {
      const off = await operationBus.subscribe(id, {
        awaitChunkHandlers: true,
        onChunk: (chunk) => {
          if (stopping || finished || !onChunk) return;
          const work = (async () => {
            try {
              await onChunk(chunk);
            } catch (error) {
              void dispose(error);
            }
          })();
          running.add(work);
          void work.finally(() => running.delete(work));
          return work;
        },
        onDone: (done) => finish({ ok: true, done }),
        onError: (error) => finish({ ok: false, error }),
      });
      if (stopping || finished) off();
      else unsubscribe = off;
    })();
    try {
      await subscribing;
    } catch (error) {
      void dispose(error);
    }
  })();

  if (opts.timeoutMs) {
    timer = setTimeout(
      () => void dispose(new Error("SQL_QUERY_TIMEOUT")),
      opts.timeoutMs
    );
  }

  return {
    result,
    cancel: () => dispose(createAbortError()),
    settled,
  };
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  const message =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown })?.message === "string"
        ? (error as { message: string }).message
        : typeof (error as { error?: unknown })?.error === "string"
          ? (error as { error: string }).error
          : "SQL operation failed";
  return new Error(message);
}

/** One statement whose rows are not needed (a restore statement). */
export function dumpStatement(
  connectionId: string,
  sql: string,
  opts: DumpSqlOptions = {}
): DumpOperation<void> {
  return start(connectionId, sql, "direct", opts, null, () => undefined);
}

/** A row stream handed to `onChunk` in order, chunk by chunk (backups). */
export function dumpStream(
  connectionId: string,
  sql: string,
  onChunk: (chunk: TableChunk) => void | Promise<void>,
  opts: DumpSqlOptions = {}
): DumpOperation<OperationDone> {
  return start(connectionId, sql, "stream", opts, onChunk, (done) => done);
}
