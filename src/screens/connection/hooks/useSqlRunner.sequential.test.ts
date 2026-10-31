import { act, renderHook } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  validate: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("src/lib/tauri/operation", () => ({
  operationCancel: mocks.cancel,
  operationExecute: vi.fn(),
}));
vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: {
    ensureInit: vi.fn().mockResolvedValue(undefined),
    subscribe: mocks.subscribe,
  },
}));
vi.mock("src/lib/tauri/queryValidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri/queryValidate")>()),
  validateSqlQueryBE: mocks.validate,
}));

import { clearSqlRunnerWindowState, useSqlRunner } from "./useSqlRunner";
import type { RunSqlReturn } from "./useSqlHistoryRunner";
import { clearSqlStream } from "./useSqlStreamResult";
import { TabTargetError } from "src/lib/tabs/assertTabTarget";

let WIN = "scope:seq";
let winSeq = 0;

type Handlers = {
  onChunk: (chunk: unknown) => void;
  onDone: (done: unknown) => void;
  onError: (err: unknown) => void;
};

const handlersByOp = new Map<string, Handlers>();
const order: string[] = [];
let opSeq = 0;
const opIds: string[] = [];

function setup() {
  const onRunSql = vi.fn(async ({ sql }: { sql: string }) => {
    order.push(`run:${sql}`);
    const opId = `op-${++opSeq}`;
    opIds.push(opId);
    return { mode: "stream" as const, opId };
  });
  const hook = renderHook(() =>
    useSqlRunner({
      activeSqlWindowId: WIN,
      runtimeConnectionId: "conn-1",
      engine: "postgres",
      sqlSafetyMode: "default",
      isProfileLocked: false,
      onRunSql,
    })
  );
  return { hook, onRunSql };
}

/** Lets awaited promises and microtasks settle. */
async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function finish(opId: string) {
  const handlers = handlersByOp.get(opId);
  expect(handlers, `stream ${opId} subscribed`).toBeTruthy();
  act(() => {
    handlers!.onDone({
      op_id: opId,
      truncated: false,
      row_count: 0,
      elapsed_ms: 1,
    });
  });
}

const slots = (hook: ReturnType<typeof setup>["hook"]) =>
  hook.result.current.sqlRuns[
    hook.result.current.sqlRuns.length - 1
  ]?.slots.map((slot: { status: string }) => slot.status);

beforeEach(() => {
  WIN = `scope:seq-${++winSeq}`;
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  handlersByOp.clear();
  order.length = 0;
  opIds.length = 0;
  opSeq = 0;
  mocks.validate
    .mockReset()
    .mockImplementation(async (_c: string, sql: string) => {
      order.push(`validate:${sql}`);
    });
  mocks.subscribe
    .mockReset()
    .mockImplementation(async (id: string, h: Handlers) => {
      handlersByOp.set(id, h);
      return () => {};
    });
});

afterEach(() => {
  vi.useRealTimers();
  clearSqlRunnerWindowState(WIN);
  for (const opId of opIds) clearSqlStream(opId);
});

describe("useSqlRunner statement order", () => {
  it("runs a script's statements one at a time, each after the previous ended", async () => {
    const { hook } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "create table t (id int); insert into t values (1); select * from t",
    });
    await flush();

    // Only the first statement started; the second waits for it to end.
    expect(order).toEqual([
      "validate:create table t (id int)",
      "run:create table t (id int)",
    ]);
    expect(slots(hook)).toEqual(["running", "queued", "queued"]);

    finish("op-1");
    await flush();
    expect(order.slice(2)).toEqual([
      "validate:insert into t values (1)",
      "run:insert into t values (1)",
    ]);

    finish("op-2");
    await flush();
    expect(order[order.length - 1]).toBe("run:select * from t");
    finish("op-3");
    await flush();
    expect(slots(hook)).toEqual(["done", "done", "done"]);
  });

  it("stops the run when the tab may no longer use its connection (D3)", async () => {
    const { hook, onRunSql } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "create table t (id int); insert into t values (1); select * from t",
    });
    await flush();
    // The tab reconnects while the first statement runs.
    onRunSql.mockImplementation(async () => {
      throw new TabTargetError({
        code: "RUNTIME_NOT_AUTHORITATIVE",
        message: "This tab no longer uses this connection. Reconnect the tab.",
      });
    });
    finish("op-1");
    await flush();
    await flush();
    expect(onRunSql).toHaveBeenCalledTimes(2);
    expect(order).not.toContain("validate:select * from t");
    const run =
      hook.result.current.sqlRuns[hook.result.current.sqlRuns.length - 1]!;
    expect(run.slots[1]!.status).toBe("error");
    expect(run.slots[1]!.error).toContain("no longer uses this connection");
    expect(run.slots[2]!.status).toBe("queued");
  });

  it("marks a statement done however long its stream ran", async () => {
    vi.useFakeTimers();
    const { hook } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select pg_sleep(120)",
    });
    await flush();
    expect(slots(hook)).toEqual(["running"]);

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    finish("op-1");
    await flush();
    expect(slots(hook)).toEqual(["done"]);
  });

  it("keeps a silent statement running, and the next one waiting, past the idle failsafe", async () => {
    vi.useFakeTimers();
    const { hook } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select pg_sleep(120); select 2",
    });
    await flush();

    for (const ms of [1_500, 65_000]) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
      await flush();
      expect(slots(hook)).toEqual(["running", "queued"]);
      expect(order).not.toContain("validate:select 2");
    }

    finish("op-1");
    await flush();
    expect(order[order.length - 1]).toBe("run:select 2");
  });

  it("reports a statement's real error, then runs the next one", async () => {
    const { hook } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select 1/0; select 2",
    });
    await flush();
    act(() => {
      handlersByOp
        .get("op-1")!
        .onError({ op_id: "op-1", error: "division by zero" });
    });
    await flush();
    finish("op-2");
    await flush();
    const run =
      hook.result.current.sqlRuns[hook.result.current.sqlRuns.length - 1]!;
    expect(run.slots.map((slot: { status: string }) => slot.status)).toEqual([
      "error",
      "done",
    ]);
    expect(run.slots[0]!.error).toContain("division by zero");
  });
});

describe("useSqlRunner stopping a waiting script", () => {
  async function startWaiting() {
    vi.useFakeTimers();
    const { hook } = setup();
    let settled = false;
    void hook.result.current
      .startRun({
        windowId: WIN,
        sql: "select pg_sleep(60); select 2; select 3",
      })
      .then(() => (settled = true));
    await flush();
    expect(slots(hook)).toEqual(["running", "queued", "queued"]);
    return { hook, isSettled: () => settled };
  }

  async function runAgain(hook: ReturnType<typeof setup>["hook"]) {
    await act(async () => {
      vi.advanceTimersByTime(500); // past the run throttle
    });
    const before = order.length;
    void hook.result.current.startRun({ windowId: WIN, sql: "select 9" });
    await flush();
    return order.slice(before);
  }

  for (const how of ["close", "cancel", "reset"] as const) {
    it(`ends on ${how}: no further statement runs and Run works again`, async () => {
      const { hook, isSettled } = await startWaiting();
      const runId = hook.result.current.sqlRuns[0]!.id;
      act(() => {
        if (how === "close") hook.result.current.closeRun(runId);
        else if (how === "cancel") hook.result.current.cancelRun(runId);
        else hook.result.current.reset();
      });
      await flush();

      expect(isSettled()).toBe(true);
      expect(order).not.toContain("validate:select 2");
      expect(await runAgain(hook)).toEqual([
        "validate:select 9",
        "run:select 9",
      ]);
    });
  }

  it("never lets an older start reopen the gate a newer run holds", async () => {
    const { hook } = await startWaiting();
    const firstId = hook.result.current.sqlRuns[0]!.id;
    act(() => hook.result.current.cancelRun(firstId));
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    // A new script starts and waits on its first statement...
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select pg_sleep(60); select 5",
    });
    await flush();
    // ...so another Run is refused until it ends.
    const blocked = await runAgain(hook);
    expect(blocked).toEqual([]);
  });
});

describe("useSqlRunner runs ended before the backend answered", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("never runs a cleared window's statement after the window is reused", async () => {
    vi.useFakeTimers();
    const held = deferred<void>();
    mocks.validate.mockImplementation(async (_c: string, sql: string) => {
      order.push(`validate:${sql}`);
      if (sql === "select 111") await held.promise;
    });
    const first = setup();
    void first.hook.result.current.startRun({
      windowId: WIN,
      sql: "select 111",
    });
    await flush();

    act(() => clearSqlRunnerWindowState(WIN));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const second = setup();
    void second.hook.result.current.startRun({
      windowId: WIN,
      sql: "select pg_sleep(1); select 2",
    });
    await flush();

    held.resolve();
    await flush();
    expect(order).not.toContain("run:select 111");
    expect(order).toContain("run:select pg_sleep(1)");
  });

  it("frees Run when the run is closed while its start is pending, and stops a late stream", async () => {
    vi.useFakeTimers();
    const pending = deferred<RunSqlReturn>();
    const onRunSql = vi
      .fn()
      .mockImplementationOnce(async ({ sql }: { sql: string }) => {
        order.push(`run:${sql}`);
        return pending.promise;
      })
      .mockImplementation(async ({ sql }: { sql: string }) => {
        order.push(`run:${sql}`);
        return { mode: "stream" as const, opId: `op-${++opSeq}` };
      });
    const hook = renderHook(() =>
      useSqlRunner({
        activeSqlWindowId: WIN,
        runtimeConnectionId: "conn-1",
        engine: "postgres",
        sqlSafetyMode: "default",
        isProfileLocked: false,
        onRunSql,
      })
    );
    let settled = false;
    void hook.result.current
      .startRun({ windowId: WIN, sql: "select 1; select 2" })
      .then(() => (settled = true));
    await flush();

    act(() => hook.result.current.closeRun(hook.result.current.sqlRuns[0]!.id));
    await flush();
    expect(settled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    void hook.result.current.startRun({ windowId: WIN, sql: "select 9" });
    await flush();
    expect(order).toContain("run:select 9");
    expect(order).not.toContain("run:select 2");

    // The first start answers late: its stream is stopped, not adopted.
    pending.resolve({ mode: "stream", opId: "late-op" });
    await flush();
    expect(mocks.cancel).toHaveBeenCalledWith("late-op");
  });
});

describe("useSqlRunner run identity", () => {
  it("keeps the editor's source key on the run", async () => {
    const { hook } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select 1",
      sourceKey: "draft#7",
    });
    await flush();
    expect(hook.result.current.sqlRuns[0]!.sourceKey).toBe("draft#7");
  });
});

describe("useSqlRunner result tabs per statement", () => {
  it("names every statement Query n, continuing across runs", async () => {
    const { hook } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select 1; select 2",
    });
    await flush();
    finish("op-1");
    await flush();
    finish("op-2");
    await flush();
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    void hook.result.current.startRun({ windowId: WIN, sql: "select 3" });
    await flush();
    const titles = hook.result.current.sqlRuns.flatMap((run) =>
      run.slots.map((slot: { title?: string }) => slot.title)
    );
    expect(titles).toEqual(["Query 1", "Query 2", "Query 3"]);
  });

  it("closes one finished statement, but a running script as a whole", async () => {
    const { hook } = setup();
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select 1; select 2",
    });
    await flush();
    finish("op-1");
    await flush();
    finish("op-2");
    await flush();
    const runId = hook.result.current.sqlRuns[0]!.id;
    act(() => hook.result.current.closeSlot(runId, 0));
    expect(
      hook.result.current.sqlRuns[0]!.slots.map(
        (slot: { title?: string }) => slot.title
      )
    ).toEqual(["Query 2"]);

    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    void hook.result.current.startRun({
      windowId: WIN,
      sql: "select pg_sleep(9); select 4",
    });
    await flush();
    const running = hook.result.current.sqlRuns[1]!;
    act(() => hook.result.current.closeSlot(running.id, 1));
    await flush();
    expect(hook.result.current.sqlRuns.map((run) => run.id)).toEqual([runId]);
    expect(order).not.toContain("run:select 4");
  });
});
