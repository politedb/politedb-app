import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  invoke: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    m.listeners.set(name, cb);
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));

import { operationBus } from "./operationBus";

const emit = (name: string, payload: unknown) =>
  m.listeners.get(name)!({ payload });
const chunk = (op: string, seq: number) => ({
  op_id: op,
  seq,
  rows: [[seq]],
});
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const acked = (op: string) =>
  m.invoke.mock.calls
    .filter((c: any[]) => c[1]?.input?.op_id === op)
    .reduce((n: number, c: any[]) => n + c[1].input.permits, 0);

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 0;
  });
  m.invoke.mockClear();
  await operationBus.ensureInit();
});

describe("operationBus.invalidate", () => {
  it("drops an owner's later chunks and terminal events, ACKing the chunks", async () => {
    const seen: number[] = [];
    const done = vi.fn();
    await operationBus.subscribe("op-a", {
      awaitChunkHandlers: true,
      onChunk: (c: any) => {
        seen.push(c.seq);
      },
      onDone: done,
    });
    emit("op:chunk_table", chunk("op-a", 1));
    await flush();
    operationBus.invalidate("op-a");
    emit("op:chunk_table", chunk("op-a", 2));
    emit("op:chunk_table", chunk("op-a", 3));
    await flush();
    // Nothing cached for a late subscriber either.
    expect(operationBus.hasPendingChunks("op-a")).toBe(false);
    const late = vi.fn();
    await operationBus.subscribe("op-a", { onChunk: late, onDone: late });
    emit("op:chunk_table", chunk("op-a", 4));
    emit("op:done", { op_id: "op-a", row_count: 4 });
    await flush();
    expect(seen).toEqual([1]);
    expect(done).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    // Every chunk was ACKed: the backend is never left waiting.
    expect(acked("op-a")).toBe(4);
  });

  it("keeps dropping a given-up op's chunks long after the cache TTL", async () => {
    // Fake the cleanup timer and clock only (ACKs flush on the frame).
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
    try {
      operationBus.invalidate("op-slow");
      // Far past the orphan-cache TTL and its cleanup runs.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      emit("op:chunk_table", chunk("op-slow", 1));
      emit("op:error", { op_id: "op-slow", error: "late" });
      await flush();
      expect(operationBus.hasPendingChunks("op-slow")).toBe(false);
      expect(acked("op-slow")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops chunks queued behind a running handler when invalidated meanwhile", async () => {
    let release!: () => void;
    const seen: number[] = [];
    await operationBus.subscribe("op-b", {
      awaitChunkHandlers: true,
      onChunk: async (c: any) => {
        seen.push(c.seq);
        if (c.seq === 1) await new Promise<void>((r) => (release = r));
      },
    });
    emit("op:chunk_table", chunk("op-b", 1));
    emit("op:chunk_table", chunk("op-b", 2));
    await flush();
    operationBus.invalidate("op-b");
    release();
    await flush();
    expect(seen).toEqual([1]);
    expect(acked("op-b")).toBe(2);
  });

  it("leaves other operations untouched", async () => {
    const seen: number[] = [];
    await operationBus.subscribe("op-c", {
      onChunk: (c: any) => {
        seen.push(c.seq);
      },
    });
    operationBus.invalidate("op-other");
    emit("op:chunk_table", chunk("op-c", 1));
    await flush();
    expect(seen).toEqual([1]);
  });
});
