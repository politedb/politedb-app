import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dump port over the real busy-retry helper (query.ts), with the raw
 * execute and cancel IPCs held: an id that arrives after the cancel is
 * adopted, invalidated and cancelled before the operation settles.
 */

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("./operation", () => ({
  operationExecute: m.execute,
  operationCancel: m.cancel,
}));
vi.mock("./operationBus", () => ({
  operationBus: {
    ensureInit: async () => {},
    subscribe: m.subscribe,
    invalidate: m.invalidate,
  },
}));
vi.mock("src/lib/analytics", () => ({
  detectSqlKind: () => "other",
  trackEvent: vi.fn(),
}));

import { dumpStatement } from "./dumpOperation";

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
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  m.subscribe.mockResolvedValue(() => {});
});

describe("dump operations over the real retry helper", () => {
  it("settle only after a late id was adopted, invalidated and cancelled", async () => {
    const id = deferred<string>();
    const cancelled = deferred<void>();
    m.execute.mockReturnValue(id.promise);
    m.cancel.mockReturnValue(cancelled.promise);
    const op = dumpStatement("c1", "UPDATE t SET a = 1");
    await flush();
    const ack = op.cancel();
    let settled = false;
    void op.settled.then(() => (settled = true));
    await flush();
    // The raw execute has not answered: nothing is settled yet.
    expect(settled).toBe(false);
    id.resolve("late-op");
    await flush();
    expect(m.invalidate).toHaveBeenCalledWith("late-op");
    expect(m.cancel).toHaveBeenCalledWith("late-op");
    // Still waiting on the backend cancel itself.
    expect(settled).toBe(false);
    cancelled.resolve();
    expect(await ack).toEqual({ kind: "requested" });
    expect(await op.settled).toMatchObject({ kind: "client-disposed" });
    expect(m.cancel).toHaveBeenCalledTimes(1);
    expect(m.subscribe).not.toHaveBeenCalled();
  });

  it("report a rejected cancel of a late id", async () => {
    const id = deferred<string>();
    m.execute.mockReturnValue(id.promise);
    m.cancel.mockRejectedValue(new Error("ipc down"));
    const op = dumpStatement("c1", "UPDATE t SET a = 1");
    await flush();
    const ack = op.cancel();
    id.resolve("late-op");
    expect(await ack).toMatchObject({ kind: "rejected" });
    expect(m.invalidate).toHaveBeenCalledWith("late-op");
    expect(await op.settled).toMatchObject({ kind: "client-disposed" });
  });

  it("send no further attempt once stopped, even when the first was busy", async () => {
    const first = deferred<string>();
    m.execute.mockReturnValueOnce(first.promise);
    m.cancel.mockResolvedValue(undefined);
    const op = dumpStatement("c1", "DELETE FROM t");
    await flush();
    void op.cancel();
    await flush();
    // The connection was busy: the helper would cancel the holder and retry.
    first.reject(
      new Error("ERR_SQL_BUSY:0b6b2f0e-6a3f-4d0e-9d5e-2f1c9a4b7e10")
    );
    expect(await op.settled).toMatchObject({ kind: "client-disposed" });
    expect(m.execute).toHaveBeenCalledTimes(1);
    // Nobody else's operation is cancelled on its behalf.
    expect(m.cancel).not.toHaveBeenCalled();
  });

  it("send no further attempt after its timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const first = deferred<string>();
      m.execute.mockReturnValueOnce(first.promise);
      const op = dumpStatement("c1", "DELETE FROM t", { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(100);
      first.reject(new Error("ERR_SQL_BUSY"));
      await vi.advanceTimersByTimeAsync(5_000);
      const settled = await op.settled;
      expect((settled.error as Error).message).toBe("SQL_QUERY_TIMEOUT");
      expect(m.execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
