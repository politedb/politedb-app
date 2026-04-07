import {
  ColumnMeta,
  QueryResult,
  TableChunk,
} from "./types";
import { operationCancel, operationExecute } from "./operation";
import { operationBus } from "./operationBus";
import { toErrorMessage } from "./queryValidate";

type RunRedisCommandOptions = {
  batchSize?: number;
  maxRows?: number;
  timeoutMs?: number;
  commandTimeoutMs?: number;
  pattern?: string;
  scanCount?: number;
};

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

export async function runRedisCommand(
  connectionId: string,
  cmd: string,
  args: string[] = [],
  opts?: RunRedisCommandOptions
): Promise<QueryResult> {
  await operationBus.ensureInit();

  const opId = await operationExecute({
    connection_id: connectionId,
    kind: "redis_command",
    redis: {
      cmd,
      args,
      batch_size: opts?.batchSize ?? 200,
      max_rows: opts?.maxRows,
      command_timeout_ms: opts?.commandTimeoutMs,
      pattern: opts?.pattern,
      scan_count: opts?.scanCount,
    },
  });

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

    resolve({
      columns: normalizeDoneColumns(done),
      rows: buffer.filter((r) => r !== undefined),
      rowCount: Number(done?.row_count ?? buffer.length),
    });
  };

  const finalizeErr = (err: any, reject: (e: Error) => void) => {
    if (finished) return;
    finished = true;
    cleanup();
    reject(new Error(toErrorMessage(err)));
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
        reject(new Error("REDIS_COMMAND_TIMEOUT"));
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
