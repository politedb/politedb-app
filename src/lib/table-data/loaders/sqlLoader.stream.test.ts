import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(async () => {}),
  handlers: new Map<string, Record<string, (v?: unknown) => void>>(),
}));

vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: vi.fn(),
  startSqlQueryStream: m.start,
}));
vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: {
    subscribe: async (
      opId: string,
      h: Record<string, (v?: unknown) => void>
    ) => {
      m.handlers.set(opId, h);
      return () => {};
    },
  },
}));
vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  operationCancel: m.cancel,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { startRowsStream } from "./sqlLoader";
import { STALE_LOAD } from "../helpers";
import { useConnectionStore } from "src/stores/connection";

const KEY = "t.public.items";
let current = true;

function stream() {
  return startRowsStream({
    key: KEY,
    connId: "rt-a",
    schema: "public",
    tableName: "items",
    engine: "postgres",
    limit: 10,
    offset: 0,
    addLogQuery: () => {},
    isCurrent: () => current,
    owner: "owner-1",
  });
}

const rows = () => useConnectionStore.getState().tableRowsByKey[KEY];
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  current = true;
  m.handlers.clear();
  useConnectionStore.setState({
    tableRowsByKey: {},
    tableRowCacheByKey: {},
  } as never);
});
afterEach(() => vi.clearAllMocks());

describe("a SQL row stream of a load that moved on (R5)", () => {
  it("cancels a late start reply and never begins", async () => {
    let reply!: (id: string) => void;
    m.start.mockReturnValue(new Promise<string>((r) => (reply = r)));
    const run = stream();
    await settle();
    current = false;
    reply("op-1");
    await expect(run).rejects.toThrow(STALE_LOAD);
    expect(m.cancel).toHaveBeenCalledWith("op-1");
    expect(rows()?.opId).not.toBe("op-1");
    expect(m.handlers.has("op-1")).toBe(false);
  });

  it("stops at a stale chunk and writes nothing more", async () => {
    m.start.mockResolvedValue("op-2");
    const run = stream();
    await settle();
    const h = m.handlers.get("op-2")!;
    h.onChunk!({ rows: [[1]], row_offset: 0, seq: 0 });
    const before = JSON.stringify(rows()?.rows);
    current = false;
    h.onChunk!({ rows: [[2]], row_offset: 1, seq: 1 });
    await expect(run).rejects.toThrow(STALE_LOAD);
    expect(JSON.stringify(rows()?.rows)).toBe(before);
    expect(m.cancel).toHaveBeenCalledWith("op-2");
    // Its window is retired, not left running.
    expect(rows()?.running).toBe(false);
  });

  it("ends a stale done or error without publishing it", async () => {
    for (const event of ["onDone", "onError"] as const) {
      current = true;
      m.start.mockResolvedValue(`op-${event}`);
      const run = stream();
      await settle();
      current = false;
      m.handlers.get(`op-${event}`)![event]!(new Error("late"));
      await expect(run).rejects.toThrow(STALE_LOAD);
      expect(rows()?.running).toBe(false);
      expect(rows()?.error ?? null).toBeNull();
    }
  });
});
