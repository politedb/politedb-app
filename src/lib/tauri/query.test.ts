import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSqlQuery } from "./query";

const trackEventMock = vi.fn();
vi.mock("src/lib/analytics", () => ({
  detectSqlKind: () => "select",
  trackEvent: (...args: any[]) => trackEventMock(...args),
}));

// ---- Polyfill window for node environment (runSqlQuery uses window.setTimeout)
const g: any = globalThis as any;
if (!g.window) g.window = g;

// ---- Mocks
const subscribeMock = vi.fn();
const ensureInitMock = vi.fn();
const operationExecuteMock = vi.fn();
const operationCancelMock = vi.fn();
const toErrorMessageMock = vi.fn((e: any) => String(e?.message ?? e ?? "ERR"));

vi.mock("./operationBus", () => ({
  operationBus: {
    ensureInit: (...args: any[]) => ensureInitMock(...args),
    subscribe: (...args: any[]) => subscribeMock(...args),
  },
}));

vi.mock("src/lib/tauri", () => ({
  operationExecute: (...args: any[]) => operationExecuteMock(...args),
  operationCancel: (...args: any[]) => operationCancelMock(...args),
}));

vi.mock("./queryValidate", () => ({
  toErrorMessage: (e: unknown) => toErrorMessageMock(e),
}));

type SubscribeHandlers = {
  onChunk?: (chunk: any) => void;
  onDone?: (done: any) => void;
  onError?: (err: any) => void;
};

function setupSubscribeCapture() {
  let handlers: SubscribeHandlers | null = null;
  const unsub = vi.fn();

  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));

  subscribeMock.mockImplementation(
    async (_opId: string, h: SubscribeHandlers) => {
      handlers = h;
      readyResolve();
      return unsub;
    }
  );

  return {
    ready,
    get handlers() {
      if (!handlers) throw new Error("handlers not set");
      return handlers;
    },
    unsub,
  };
}

beforeEach(() => {
  vi.useFakeTimers();

  subscribeMock.mockReset();
  ensureInitMock.mockReset();
  operationExecuteMock.mockReset();
  operationCancelMock.mockReset();
  toErrorMessageMock.mockClear();
  trackEventMock.mockReset();

  ensureInitMock.mockResolvedValue(undefined);
  operationExecuteMock.mockResolvedValue("op_1");
  operationCancelMock.mockResolvedValue(undefined);
});

afterEach(() => {
  // Important: only clear timers; do NOT run pending timers here
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("runSqlQuery", () => {
  it("calls operationExecute with defaults and returns rows+columns on done", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("conn_1", "select 1", { timeoutMs: 0 });

    // ensure subscribe completed and runSqlQuery assigned `unsub`
    await cap.ready;
    await Promise.resolve();

    cap.handlers.onChunk?.({ rows: [[1], [2]] });
    cap.handlers.onChunk?.({ rows: [[3]] });

    cap.handlers.onDone?.({
      columns: [{ name: "id", db_type: "int4" }],
      row_count: 3,
    });

    const res = await p;

    expect(operationExecuteMock).toHaveBeenCalledWith({
      connection_id: "conn_1",
      kind: "sql_query",
      sql: {
        sql: "select 1",
        batch_size: 100,
        max_rows: undefined,
        client_mode: "direct",
      },
    });

    expect(res.columns).toEqual([{ name: "id", db_type: "int4" }]);
    expect(res.rows).toEqual([[1], [2], [3]]);
    expect(res.rowCount).toBe(3);
    expect(cap.unsub).toHaveBeenCalledTimes(1);
  });

  it("respects opts.batchSize/maxRows", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("c", "q", {
      batchSize: 999,
      maxRows: 123,
      timeoutMs: 0,
    });

    await cap.ready;
    await Promise.resolve();

    const handlers = subscribeMock.mock.calls[0]![1] as SubscribeHandlers;
    handlers.onDone?.({ columns: [], row_count: 0 });

    await p;

    expect(operationExecuteMock).toHaveBeenCalledWith({
      connection_id: "c",
      kind: "sql_query",
      sql: {
        sql: "q",
        batch_size: 999,
        max_rows: 123,
        client_mode: "direct",
      },
    });
  });

  it("buffers by row_offset and removes holes on finalize", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("c", "q", { timeoutMs: 0 });

    await cap.ready;
    await Promise.resolve();

    cap.handlers.onChunk?.({ row_offset: 5, rows: [["a"], ["b"]] });
    cap.handlers.onChunk?.({ row_offset: 0, rows: [["x"], ["y"]] });

    cap.handlers.onDone?.({
      columns: [{ name: "v", db_type: "text" }],
      row_count: 4,
    });

    const res = await p;
    expect(res.rows).toEqual([["x"], ["y"], ["a"], ["b"]]);
    expect(res.rowCount).toBe(4);
    expect(cap.unsub).toHaveBeenCalledTimes(1);
  });

  it("normalizes columns safely when done.columns is missing/invalid", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("c", "q", { timeoutMs: 0 });

    await cap.ready;
    await Promise.resolve();

    cap.handlers.onChunk?.({ rows: [[1]] });
    cap.handlers.onDone?.({ columns: "nope", row_count: 1 });

    const res = await p;
    expect(res.columns).toEqual([]);
    expect(res.rows).toEqual([[1]]);
    expect(cap.unsub).toHaveBeenCalledTimes(1);
  });

  it("rejects with normalized error message on onError, and unsubscribes", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("c", "q", { timeoutMs: 0 });

    await cap.ready;
    await Promise.resolve(); // <-- critical: allow `unsub` assignment

    cap.handlers.onError?.(new Error("db down"));

    await expect(p).rejects.toThrow("db down");
    expect(toErrorMessageMock).toHaveBeenCalled();
    expect(cap.unsub).toHaveBeenCalledTimes(1);
  });

  it("rejects if subscribe throws", async () => {
    subscribeMock.mockImplementationOnce(async () => {
      throw new Error("subscribe failed");
    });

    const p = runSqlQuery("c", "q", { timeoutMs: 0 });
    await expect(p).rejects.toThrow("subscribe failed");
  });

  it("times out, cancels operation, and rejects with SQL_QUERY_TIMEOUT", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("c", "q", { timeoutMs: 1000 });

    await cap.ready;
    await Promise.resolve();

    const assertion = expect(p).rejects.toThrow("SQL_QUERY_TIMEOUT");

    await vi.advanceTimersByTimeAsync(1000);

    // flush async inside timeout callback (await operationCancel)
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    await assertion;

    await expect(p).rejects.toThrow("SQL_QUERY_TIMEOUT");

    expect(operationCancelMock).toHaveBeenCalledWith("op_1");
    expect(cap.unsub).toHaveBeenCalledTimes(1);

    // ignore late events
    cap.handlers.onDone?.({
      columns: [{ name: "x", db_type: "t" }],
      row_count: 1,
    });
  });

  it("timeoutMs <= 0 disables timeout timer", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("c", "q", { timeoutMs: 0 });

    await cap.ready;
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(999999);
    await Promise.resolve();
    await Promise.resolve();

    cap.handlers.onDone?.({ columns: [], row_count: 0 });

    await expect(p).resolves.toMatchObject({ rowCount: 0 });
    expect(operationCancelMock).not.toHaveBeenCalled();
    expect(cap.unsub).toHaveBeenCalledTimes(1);
  });

  it("ignores empty chunks (rows missing/empty)", async () => {
    const cap = setupSubscribeCapture();

    const p = runSqlQuery("c", "q", { timeoutMs: 0 });

    await cap.ready;
    await Promise.resolve();

    cap.handlers.onChunk?.({ rows: [] });
    cap.handlers.onChunk?.({});
    cap.handlers.onChunk?.({ rows: [[1]] });

    cap.handlers.onDone?.({ columns: [], row_count: 1 });

    const res = await p;
    expect(res.rows).toEqual([[1]]);
    expect(cap.unsub).toHaveBeenCalledTimes(1);
  });
});

describe("runSqlQuery privacy and cancellation", () => {
  it("internal: true suppresses telemetry", async () => {
    const cap = setupSubscribeCapture();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0, internal: true });
    await cap.ready;
    await Promise.resolve();
    cap.handlers.onDone?.({ columns: [], row_count: 0 });
    await p;
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it("default callers still emit telemetry", async () => {
    const cap = setupSubscribeCapture();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0 });
    await cap.ready;
    await Promise.resolve();
    cap.handlers.onDone?.({ columns: [], row_count: 0 });
    await p;
    expect(trackEventMock).toHaveBeenCalled();
  });

  it("AbortSignal cancels only this operation including late creation", async () => {
    let resolveExec!: (v: string) => void;
    const execStarted = new Promise<void>((resolveStarted) => {
      operationExecuteMock.mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            resolveExec = r;
            resolveStarted();
          })
      );
    });

    const ac = new AbortController();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0, signal: ac.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });

    await execStarted;
    // Abort while execute is pending; late-created op must still be cancelled
    ac.abort();
    resolveExec("op_late");

    await assertion;
    expect(operationCancelMock).toHaveBeenCalledWith("op_late");
  });

  it("busy-retry recognizes object-shaped Tauri ERR_SQL_BUSY errors", async () => {
    const busyId = "22222222-2222-2222-2222-222222222222";
    operationExecuteMock
      .mockRejectedValueOnce({ message: `ERR_SQL_BUSY:${busyId}` })
      .mockResolvedValueOnce("op_ok");

    const cap = setupSubscribeCapture();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0, internal: true });
    // Known holder id → cancel + immediate retry (no backoff sleep).
    await Promise.resolve();
    await Promise.resolve();
    await cap.ready;
    await Promise.resolve();
    cap.handlers.onDone?.({ columns: [], row_count: 0 });
    await p;

    expect(operationCancelMock).toHaveBeenCalledWith(busyId);
    expect(operationExecuteMock).toHaveBeenCalledTimes(2);
  });

  it("busy-retry cancels the holding stream op before retrying", async () => {
    const busyId = "11111111-1111-1111-1111-111111111111";
    operationExecuteMock
      .mockRejectedValueOnce(new Error(`ERR_SQL_BUSY:${busyId}`))
      .mockResolvedValueOnce("op_ok");

    const cap = setupSubscribeCapture();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0, internal: true });
    // Immediate retry after cancel — do not advance fake timers.
    await Promise.resolve();
    await Promise.resolve();
    await cap.ready;
    await Promise.resolve();
    cap.handlers.onDone?.({ columns: [], row_count: 0 });
    await p;

    expect(operationCancelMock).toHaveBeenCalledWith(busyId);
    expect(operationExecuteMock).toHaveBeenCalledTimes(2);
  });

  it("busy-retry parses bare-string and wrapped invoke ERR_SQL_BUSY", async () => {
    const busyId = "33333333-3333-3333-3333-333333333333";
    operationExecuteMock
      .mockRejectedValueOnce(`ERR_SQL_BUSY:${busyId}`)
      .mockRejectedValueOnce(
        `error invoking operation_execute: ERR_SQL_BUSY:${busyId}`
      )
      .mockResolvedValueOnce("op_ok");

    const cap = setupSubscribeCapture();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0, internal: true });
    // Two known-holder failures → two immediate cancel+retries (no sleep).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await cap.ready;
    await Promise.resolve();
    cap.handlers.onDone?.({ columns: [], row_count: 0 });
    await p;

    expect(operationCancelMock).toHaveBeenCalledWith(busyId);
    expect(operationCancelMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(operationExecuteMock).toHaveBeenCalledTimes(3);
  });

  it("busy-retry after cancel does not sleep before reacquire", async () => {
    const busyId = "44444444-4444-4444-4444-444444444444";
    let secondExecuteAt: number | null = null;
    operationExecuteMock.mockImplementation(async () => {
      if (operationExecuteMock.mock.calls.length === 1) {
        throw new Error(`ERR_SQL_BUSY:${busyId}`);
      }
      secondExecuteAt = Date.now();
      return "op_ok";
    });
    operationCancelMock.mockImplementation(async () => {
      // Simulate sync release_op: holder gone before retry.
    });

    const cap = setupSubscribeCapture();
    const started = Date.now();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0, internal: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await cap.ready;
    cap.handlers.onDone?.({ columns: [], row_count: 0 });
    await p;

    expect(operationCancelMock).toHaveBeenCalledWith(busyId);
    expect(operationExecuteMock).toHaveBeenCalledTimes(2);
    expect(secondExecuteAt).not.toBeNull();
    // Must not have waited for the old 80ms backoff window.
    expect((secondExecuteAt ?? 0) - started).toBeLessThan(50);
  });

  it("same ERR_SQL_BUSY holder uuid across retries releases after cancel", async () => {
    // Live log pattern: new op ids each attempt, SAME holder every time.
    const busyId = "37f37825-99c5-4742-af61-62e8fc3a6417";
    let released = false;
    let busyHits = 0;
    operationExecuteMock.mockImplementation(async () => {
      if (!released) {
        busyHits += 1;
        throw new Error(`ERR_SQL_BUSY:${busyId}`);
      }
      return "op_ok";
    });
    operationCancelMock.mockImplementation(async (id: string) => {
      // Mimic backend release_op: only clearing the holder frees the slot.
      if (id === busyId) released = true;
    });

    const cap = setupSubscribeCapture();
    const p = runSqlQuery("c", "select 1", { timeoutMs: 0, internal: true });
    // Several microtasks: busy → cancel → retry → subscribe
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await cap.ready;
    await Promise.resolve();
    cap.handlers.onDone?.({ columns: [], row_count: 0 });
    await p;

    expect(busyHits).toBeGreaterThanOrEqual(1);
    expect(operationCancelMock).toHaveBeenCalledWith(busyId);
    expect(released).toBe(true);
    expect(operationExecuteMock.mock.calls.length).toBe(busyHits + 1);
  });

  it("busy-retry respects abort and does not cancel unrelated work", async () => {
    operationExecuteMock
      .mockRejectedValueOnce(new Error("ERR_SQL_BUSY"))
      .mockResolvedValueOnce("op_busy");

    const ac = new AbortController();
    const p = runSqlQuery("c", "select 1", {
      timeoutMs: 0,
      signal: ac.signal,
      internal: true,
    });

    // Abort during busy backoff sleep
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // cancel may or may not have an op id yet; unrelated ops are never cancelled
    for (const call of operationCancelMock.mock.calls) {
      expect(call[0]).not.toBe("unrelated_op");
    }
  });
});

describe("runSqlQuery deadline covers startup", () => {
  it("deadline covers deferred ensureInit without waiting for init", async () => {
    ensureInitMock.mockImplementationOnce(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );

    const p = runSqlQuery("c", "select 1", { timeoutMs: 500, internal: true });
    const assertion = expect(p).rejects.toThrow("SQL_QUERY_TIMEOUT");

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await assertion;
    expect(operationExecuteMock).not.toHaveBeenCalled();
  });

  it("timeout settles even when operationCancel never resolves", async () => {
    const cap = setupSubscribeCapture();
    operationCancelMock.mockImplementationOnce(
      () =>
        new Promise(() => {
          /* hang forever */
        })
    );

    const p = runSqlQuery("c", "q", { timeoutMs: 300, internal: true });
    await cap.ready;
    await Promise.resolve();

    const assertion = expect(p).rejects.toThrow("SQL_QUERY_TIMEOUT");
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    await assertion;
    expect(operationCancelMock).toHaveBeenCalledWith("op_1");
  });

  it("deadline covers hanging execute and still cancels late-created op", async () => {
    let resolveExec!: (v: string) => void;
    operationExecuteMock.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          resolveExec = r;
        })
    );

    const p = runSqlQuery("c", "select 1", { timeoutMs: 200, internal: true });
    const assertion = expect(p).rejects.toThrow("SQL_QUERY_TIMEOUT");

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await assertion;

    // Late-created op after deadline must still be cancelled.
    resolveExec("op_late");
    await Promise.resolve();
    await Promise.resolve();
    expect(operationCancelMock).toHaveBeenCalledWith("op_late");
  });

  it("busy-retry backoff is bounded by the overall deadline", async () => {
    operationExecuteMock.mockRejectedValue(new Error("ERR_SQL_BUSY"));

    const p = runSqlQuery("c", "select 1", {
      timeoutMs: 250,
      internal: true,
    });
    const assertion = expect(p).rejects.toThrow("SQL_QUERY_TIMEOUT");

    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    await assertion;
  });
});
