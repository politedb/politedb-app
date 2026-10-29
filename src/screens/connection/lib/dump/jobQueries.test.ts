import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDumpJobStore } from "src/stores/dumpJob";
import { useScreenStore } from "src/stores/screen";

/**
 * A job's catalog queries over the real dump port: a query whose cancel the
 * backend refused stays counted after it settled, whether the job asked
 * for the cancel or the port did on a timeout.
 */

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  cancel: vi.fn(),
  handlers: new Map<string, { onDone?: (d: unknown) => void }>(),
}));

vi.mock("src/lib/tauri/query", () => ({
  operationExecuteWithBusyRetry: m.execute,
  createAbortError: () => new Error("AbortError"),
}));
vi.mock("src/lib/tauri/operation", () => ({ operationCancel: m.cancel }));
vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: {
    ensureInit: async () => {},
    subscribe: async (id: string, h: { onDone?: (d: unknown) => void }) => {
      m.handlers.set(id, h);
      return () => {};
    },
    invalidate: vi.fn(),
  },
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { catalogQuery } from "./backupSql";
import { holdJobQueries } from "./jobQueries";
import { startDumpJob } from "./dumpJobController";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function job() {
  const started = startDumpJob("backup", {
    tabId: "t1",
    runtimeConnectionId: "c1",
    engine: "mysql",
    target: "shop",
  });
  if (!started.ok) throw new Error(started.message);
  return started.job;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.handlers.clear();
  useDumpJobStore.setState({ active: null, summary: null, closing: [] });
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", profileId: "p1", runtimeConnectionId: "c1" },
    ] as never,
  });
  let n = 0;
  m.execute.mockImplementation(async () => `op${++n}`);
});

describe("a job's catalog queries", () => {
  it("are confirmed released when every cancel was accepted", async () => {
    const j = job();
    const hold = holdJobQueries(j);
    m.cancel.mockResolvedValue(undefined);
    const q = catalogQuery("c1", "SELECT 1");
    q.catch(() => {});
    await flush();
    expect(await hold.stopAll()).toBe(true);
    hold.release();
  });

  it("stay unconfirmed after a refused cancel, also once the query left", async () => {
    const j = job();
    const hold = holdJobQueries(j);
    m.cancel.mockRejectedValue(new Error("ipc down"));
    const q = catalogQuery("c1", "SELECT 1");
    q.catch(() => {});
    await flush();
    expect(await hold.stopAll()).toBe(false);
    // Nothing is running any more; the evidence is kept.
    expect(await hold.stopAll()).toBe(false);
    hold.release();
  });

  it("count a timeout whose cancel the backend refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const j = job();
      const hold = holdJobQueries(j);
      m.cancel.mockRejectedValue(new Error("ipc down"));
      const q = catalogQuery("c1", "SELECT pg_sleep(99)", { timeoutMs: 50 });
      q.catch(() => {});
      await vi.advanceTimersByTimeAsync(100);
      await expect(q).rejects.toThrow("SQL_QUERY_TIMEOUT");
      expect(await hold.stopAll()).toBe(false);
      hold.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start none once the job was cancelled", async () => {
    const j = job();
    const hold = holdJobQueries(j);
    useDumpJobStore.setState({
      active: {
        ...useDumpJobStore.getState().active!,
        cancel: { kind: "requested" },
      },
    });
    await expect(catalogQuery("c1", "SELECT 1")).rejects.toThrow("Cancelled.");
    expect(m.execute).not.toHaveBeenCalled();
    hold.release();
  });
});
