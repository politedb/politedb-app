import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSqlQuery } from "./query";

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
