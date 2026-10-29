import { beforeEach, describe, expect, it, vi } from "vitest";

type Handlers = {
  onChunk?: (chunk: any) => void | Promise<void>;
  onDone?: (done: any) => void;
  onError?: (err: any) => void;
};

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
  invalidate: vi.fn(),
  unsubscribe: vi.fn(),
  handlers: new Map<string, Handlers>(),
}));

vi.mock("./query", () => ({
  operationExecuteWithBusyRetry: m.execute,
  createAbortError: () => new Error("AbortError"),
}));
vi.mock("./operation", () => ({ operationCancel: m.cancel }));
vi.mock("./operationBus", () => ({
  operationBus: {
    ensureInit: async () => {},
    subscribe: m.subscribe,
    invalidate: m.invalidate,
  },
}));

import { dumpStatement, dumpStream } from "./dumpOperation";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  m.handlers.clear();
  m.execute.mockResolvedValue("op1");
  m.cancel.mockResolvedValue(undefined);
  m.subscribe.mockImplementation(async (id: string, h: Handlers) => {
    m.handlers.set(id, h);
    return m.unsubscribe;
  });
});

describe("dump operations", () => {
  it("are server-finished only after a running chunk handler settled", async () => {
    const write = deferred<void>();
    const op = dumpStream("c1", "SELECT 1", () => write.promise);
    await flush();
    const h = m.handlers.get("op1")!;
    void h.onChunk!({ rows: [[1]] });
    h.onDone!({ row_count: 1 });
    let settled = false;
    void op.settled.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    write.resolve();
    expect(await op.settled).toEqual({ kind: "server-finished" });
    expect(await op.result).toMatchObject({ row_count: 1 });
    expect(m.cancel).not.toHaveBeenCalled();
  });

  it("report a server error as server-finished with the error", async () => {
    const op = dumpStatement("c1", "DELETE FROM t");
    await flush();
    m.handlers.get("op1")!.onError!("permission denied");
    const settled = await op.settled;
    expect(settled.kind).toBe("server-finished");
    expect((settled.error as Error).message).toBe("permission denied");
  });

  it("cancel a dispatched op whose chunk handler throws, and drop later chunks", async () => {
    const onChunk = vi.fn(() => {
      throw new Error("bad rows");
    });
    const op = dumpStream("c1", "SELECT 1", onChunk);
    await flush();
    const h = m.handlers.get("op1")!;
    void h.onChunk!({ rows: [[1]] });
    const settled = await op.settled;
    expect(settled).toMatchObject({ kind: "client-disposed" });
    expect((settled.error as Error).message).toBe("bad rows");
    expect(m.invalidate).toHaveBeenCalledWith("op1");
    expect(m.cancel).toHaveBeenCalledWith("op1");
    expect(m.unsubscribe).toHaveBeenCalled();
    // A late chunk is not handed to the consumer.
    void h.onChunk!({ rows: [[2]] });
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it("cancel an op whose subscription failed after it was dispatched", async () => {
    m.subscribe.mockRejectedValue(new Error("listen failed"));
    const op = dumpStatement("c1", "UPDATE t SET a = 1");
    const settled = await op.settled;
    expect(settled.kind).toBe("client-disposed");
    expect(m.cancel).toHaveBeenCalledWith("op1");
  });

  it("adopt and cancel an op id that arrives after the cancel", async () => {
    const id = deferred<string>();
    m.execute.mockReturnValue(id.promise);
    const op = dumpStatement("c1", "UPDATE t SET a = 1");
    await flush();
    const ack = op.cancel();
    let settled = false;
    void op.settled.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    id.resolve("late-op");
    expect(await ack).toEqual({ kind: "requested" });
    expect(await op.settled).toMatchObject({ kind: "client-disposed" });
    expect(m.cancel).toHaveBeenCalledWith("late-op");
    expect(m.subscribe).not.toHaveBeenCalled();
  });

  it("report a rejected backend cancel without blocking settlement", async () => {
    m.cancel.mockRejectedValue(new Error("ipc down"));
    const op = dumpStatement("c1", "UPDATE t SET a = 1");
    await flush();
    const ack = await op.cancel();
    expect(ack).toMatchObject({ kind: "rejected" });
    expect(await op.settled).toMatchObject({ kind: "client-disposed" });
  });

  it("time out by the same disposal: cancelled, settled client-disposed", async () => {
    vi.useFakeTimers();
    try {
      const op = dumpStatement("c1", "SELECT pg_sleep(9)", { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(60);
      const settled = await op.settled;
      expect(settled.kind).toBe("client-disposed");
      expect((settled.error as Error).message).toBe("SQL_QUERY_TIMEOUT");
      expect(m.cancel).toHaveBeenCalledWith("op1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settle when nothing could be started", async () => {
    m.execute.mockRejectedValue(new Error("ERR_SQL_BUSY"));
    const op = dumpStatement("c1", "SELECT 1");
    const settled = await op.settled;
    expect(settled.kind).toBe("client-disposed");
    expect((settled.error as Error).message).toBe("ERR_SQL_BUSY");
    expect(m.cancel).not.toHaveBeenCalled();
  });
});
