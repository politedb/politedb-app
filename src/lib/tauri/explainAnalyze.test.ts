import { describe, expect, it, vi } from "vitest";
import { startExplainAnalyzeOperation } from "./explainAnalyze";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  overrides: Partial<Parameters<typeof startExplainAnalyzeOperation>[1]> = {}
) {
  const deps = {
    ensureInit: vi.fn(async () => {}),
    execute: vi.fn(async () => "op-1"),
    cancel: vi.fn(async () => {}),
    now: () => Date.now(),
    ...overrides,
  };
  const controller = new AbortController();
  const run = (
    extra: Partial<Parameters<typeof startExplainAnalyzeOperation>[0]> = {}
  ) =>
    startExplainAnalyzeOperation(
      {
        connectionId: "c1",
        sql: "select 1",
        signal: controller.signal,
        deadlineAt: Date.now() + 100_000,
        stillAllowed: () => true,
        ...extra,
      },
      deps as never
    );
  return { deps, controller, run };
}

describe("startExplainAnalyzeOperation", () => {
  it("initialises listeners, then sends the dedicated operation once", async () => {
    const { deps, run } = setup();
    expect(await run()).toEqual({ kind: "started", opId: "op-1" });
    expect(
      (deps.ensureInit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    ).toBeLessThan(
      (deps.execute as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    );
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.execute).toHaveBeenCalledWith({
      connection_id: "c1",
      kind: "explain_analyze",
      explain_analyze: { sql: "select 1" },
    });
  });

  it("maps backend refusals without retrying", async () => {
    for (const [message, expected] of [
      [
        "EXPLAIN_ANALYZE_REFUSED:row_lock",
        { kind: "refused", reason: "row_lock" },
      ],
      ["EXPLAIN_ANALYZE_BUSY", { kind: "busy" }],
      [
        "EXPLAIN_ANALYZE_UNSUPPORTED_ENGINE",
        { kind: "refused", reason: "unsupported_engine" },
      ],
      ["anything else", { kind: "failed" }],
    ] as const) {
      const { deps, run } = setup({
        execute: vi.fn(async () => {
          throw new Error(message);
        }),
      });
      expect(await run()).toEqual(expected);
      expect(deps.execute).toHaveBeenCalledTimes(1);
    }
  });

  it("dispatches nothing when aborted during listener setup", async () => {
    const init = deferred<void>();
    const { deps, controller, run } = setup({ ensureInit: () => init.promise });
    const pending = run();
    controller.abort();
    expect(await pending).toEqual({ kind: "aborted" });
    init.resolve();
    await Promise.resolve();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("re-checks the caller's policy right before sending", async () => {
    const { deps, run } = setup();
    expect(await run({ stillAllowed: () => false })).toEqual({
      kind: "aborted",
    });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("cancels an id that arrives after the attempt was aborted", async () => {
    const start = deferred<string>();
    const { deps, controller, run } = setup({
      execute: vi.fn(() => start.promise),
    });
    const pending = run();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ kind: "aborted" });
    start.resolve("late-op");
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.cancel).toHaveBeenCalledWith("late-op");
  });

  it("times out a start call that never answers, then cancels a late id", async () => {
    vi.useFakeTimers();
    try {
      const start = deferred<string>();
      const { deps, run } = setup({ execute: vi.fn(() => start.promise) });
      const pending = run({ deadlineAt: Date.now() + 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ kind: "timeout" });
      start.resolve("late-op");
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.cancel).toHaveBeenCalledWith("late-op");
    } finally {
      vi.useRealTimers();
    }
  });
});
