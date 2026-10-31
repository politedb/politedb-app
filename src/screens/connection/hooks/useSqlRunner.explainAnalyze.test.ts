import { act, renderHook } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri/license";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import type { DatabaseEngine } from "src/types";

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  touchId: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("src/stores/explainAnalyzeConfirm", () => ({
  confirmExplainAnalyze: mocks.confirmDialog,
}));
vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: mocks.touchId,
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
vi.mock("src/lib/tauri/explainAnalyze", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri/explainAnalyze")>()),
  startExplainAnalyzeOperation: mocks.start,
}));

import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import { clearSqlRunnerWindowState, useSqlRunner } from "./useSqlRunner";
import { clearSqlStream } from "./useSqlStreamResult";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";
import { useScreenStore } from "src/stores/screen";

const WIN = "scope:w1";

type Props = {
  connectionId?: string;
  engine?: DatabaseEngine;
  mode?: QuerySafetyMode;
  locked?: boolean;
  window?: string;
};

type Handlers = {
  onChunk: (chunk: unknown) => void;
  onDone: (done: unknown) => void;
  onError: (err: unknown) => void;
};

let handlers: Handlers | null = null;
const record = vi.fn();
const tab = { id: "tab-1", current: true };

function setPro(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

function setup(initial: Props = {}) {
  return renderHook(
    (props: Props) =>
      useSqlRunner({
        activeSqlWindowId: props.window ?? WIN,
        tabId: "tab-1",
        runtimeConnectionId:
          "connectionId" in props ? props.connectionId : "conn-1",
        engine: props.engine ?? "postgres",
        sqlSafetyMode: props.mode ?? "default",
        isProfileLocked: props.locked ?? false,
        onRunSql: vi.fn(),
        captureHistoryTarget: () => ({
          tabId: tab.id,
          label: "Local PG",
          isCurrent: () => tab.current,
          record,
        }),
      }),
    { initialProps: initial }
  );
}

type Hook = ReturnType<typeof setup>;

function analyze(
  hook: Hook,
  sql = "select * from users",
  origin?: object,
  sourceUnchanged?: () => boolean
) {
  return hook.result.current.startExplainAnalyze({
    windowId: WIN,
    sql,
    origin,
    sourceUnchanged,
  });
}

/** Holds the confirmation open; returns how to answer it. */
function holdConfirmation() {
  let answer!: (ok: boolean) => void;
  mocks.confirmDialog.mockReturnValue(
    new Promise<boolean>((resolve) => (answer = resolve))
  );
  return (ok: boolean) => answer(ok);
}

function runs(hook: Hook) {
  return hook.result.current.sqlRuns;
}

beforeEach(() => {
  resetTabRuntimes();
  seedTabRuntime({ tabId: "tab-1", runtimeId: "conn-1" });
  seedTabRuntime({ tabId: "tab-2", runtimeId: "conn-2" });
  seedTabRuntime({ tabId: "tab-old", runtimeId: "conn-old" });
  vi.useFakeTimers();
  setPro(true);
  useProUpgradeStore.setState({ feature: null });
  mocks.confirmDialog.mockReset().mockResolvedValue(true);
  mocks.touchId.mockReset().mockResolvedValue(undefined);
  mocks.start.mockReset().mockResolvedValue({ kind: "started", opId: "op-1" });
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  handlers = null;
  mocks.subscribe.mockReset().mockImplementation(async (_id, h: Handlers) => {
    handlers = h;
    return () => {};
  });
  record.mockReset();
  tab.id = "tab-1";
  tab.current = true;
});

afterEach(() => {
  clearSqlRunnerWindowState(WIN);
  clearSqlRunnerWindowState("scope:w2");
  clearSqlStream("op-1");
  vi.useRealTimers();
});

describe("startExplainAnalyze gates", () => {
  it("opens the upgrade dialog without Pro and starts nothing", async () => {
    setPro(false);
    const hook = setup();
    await act(() => analyze(hook));
    expect(useProUpgradeStore.getState().feature).toBe("query-analyzer");
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(runs(hook)).toHaveLength(0);
  });

  it("asks nothing and starts nothing on another tab's connection (D3)", async () => {
    const hook = setup({ connectionId: "conn-2" });
    await act(() => analyze(hook));
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.slots[0]?.error).toMatch(
      /no longer uses this connection/
    );
  });

  it("starts nothing when the tab's target changes during the dialog (D3)", async () => {
    mocks.confirmDialog.mockImplementation(async () => {
      useScreenStore
        .getState()
        .updateTab("tab-1", { target: { kind: "unknown" } });
      return true;
    });
    const hook = setup();
    await act(() => analyze(hook));
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("refuses other engines with a fixed message", async () => {
    const hook = setup({ engine: "mysql" });
    await act(() => analyze(hook));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.slots[0]?.error).toBe(
      "Explain Analyze is available for PostgreSQL only."
    );
  });

  it("refuses statements that may change data, before any dialog", async () => {
    const hook = setup();
    await act(() => analyze(hook, "with gone as (delete from t) select 1"));
    expect(mocks.touchId).not.toHaveBeenCalled();
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.slots[0]?.status).toBe("error");
  });

  it("refuses a plan that came from another connection", async () => {
    const hook = setup();
    await act(() => analyze(hook, "select 1", { connectionId: "conn-old" }));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.slots[0]?.error).toMatch(/earlier connection/);
  });

  const modes: QuerySafetyMode[] = ["default", "safe", "production", "lock"];
  for (const mode of modes) {
    for (const locked of [false, true]) {
      it(`follows Run's read rules in ${mode} mode (profile lock ${locked})`, async () => {
        const hook = setup({ mode, locked });
        await act(() => analyze(hook));
        const effective = mode === "lock" || locked ? "lock" : mode;
        const touchId = effective === "safe" || effective === "production";
        expect(mocks.touchId).toHaveBeenCalledTimes(touchId ? 1 : 0);
        expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
        expect(mocks.start).toHaveBeenCalledTimes(1);
      });
    }
  }

  it("stops when Touch ID fails", async () => {
    mocks.touchId.mockRejectedValue(new Error("user cancel"));
    const hook = setup({ mode: "safe" });
    await act(() => analyze(hook));
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.title).toBe("Auth failed");
  });

  it("stops when the confirmation is cancelled", async () => {
    mocks.confirmDialog.mockResolvedValue(false);
    const hook = setup();
    await act(() => analyze(hook));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(runs(hook)).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
  });

  it("asks with the tab and the classified statement", async () => {
    const hook = setup();
    await act(() => analyze(hook, "select 1; -- note"));
    expect(mocks.confirmDialog).toHaveBeenCalledWith({
      target: "Local PG",
      statement: "select 1",
    });
  });

  it("releases the attempt when the confirmation fails", async () => {
    mocks.confirmDialog.mockRejectedValueOnce(new Error("dialog ipc"));
    const hook = setup();
    await act(() => analyze(hook));
    expect(mocks.start).not.toHaveBeenCalled();
    await act(() => analyze(hook));
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  const changes: [string, Props][] = [
    ["the connection", { connectionId: "conn-2" }],
    ["the safety mode", { mode: "production" }],
    ["the profile lock", { locked: true }],
    ["the engine", { engine: "mysql" }],
    // Both are "lock" once locked; the raw mode still counts.
    ["the raw safety mode under a lock", { mode: "production", locked: true }],
  ];
  for (const [what, next] of changes) {
    it(`starts nothing when ${what} changes during the dialog`, async () => {
      let answer!: (ok: boolean) => void;
      mocks.confirmDialog.mockReturnValue(
        new Promise<boolean>((resolve) => (answer = resolve))
      );
      const hook = setup(next.locked ? { mode: "safe", locked: true } : {});
      const pending = analyze(hook);
      await act(async () => {});
      hook.rerender(next);
      await act(async () => {
        answer(true);
        await pending;
      });
      expect(mocks.start).not.toHaveBeenCalled();
      expect(runs(hook)).toHaveLength(0);
    });
  }

  it("starts nothing when Pro ends during the dialog", async () => {
    let answer!: (ok: boolean) => void;
    mocks.confirmDialog.mockReturnValue(
      new Promise<boolean>((resolve) => (answer = resolve))
    );
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {});
    setPro(false);
    await act(async () => {
      answer(true);
      await pending;
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("starts nothing when the window changes during the dialog", async () => {
    let answer!: (ok: boolean) => void;
    mocks.confirmDialog.mockReturnValue(
      new Promise<boolean>((resolve) => (answer = resolve))
    );
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {});
    hook.rerender({ window: "scope:w2" });
    await act(async () => {
      answer(true);
      await pending;
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("starts nothing when the profile tab changes during the dialog", async () => {
    const answer = holdConfirmation();
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {});
    tab.id = "tab-2";
    await act(async () => {
      answer(true);
      await pending;
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("starts nothing when the tab moved to another connection", async () => {
    const answer = holdConfirmation();
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {});
    tab.current = false;
    await act(async () => {
      answer(true);
      await pending;
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("starts nothing when the statement changed in the editor", async () => {
    const answer = holdConfirmation();
    let same = true;
    const hook = setup();
    const pending = analyze(hook, "select 1", undefined, () => same);
    await act(async () => {});
    same = false;
    await act(async () => {
      answer(true);
      await pending;
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("passes the policy check to the start call for its last re-check", async () => {
    let same = true;
    mocks.start.mockImplementation(
      async (args: { stillAllowed: () => boolean }) => {
        same = false; // edited while listeners were being set up
        return args.stillAllowed()
          ? { kind: "started", opId: "op-1" }
          : { kind: "aborted" };
      }
    );
    const hook = setup();
    await act(() => analyze(hook, "select 1", undefined, () => same));
    expect(record).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.slots[0]?.error).toBe("Cancelled.");
  });

  it("ignores a second click while the first is pending", async () => {
    let answer!: (ok: boolean) => void;
    mocks.confirmDialog.mockReturnValue(
      new Promise<boolean>((resolve) => (answer = resolve))
    );
    const hook = setup();
    const first = analyze(hook);
    await act(async () => {});
    await act(() => analyze(hook));
    await act(async () => {
      answer(true);
      await first;
    });
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});

describe("startExplainAnalyze lifecycle", () => {
  it("sends the classified statement and records history only once started", async () => {
    let started!: (value: unknown) => void;
    mocks.start.mockReturnValue(new Promise((resolve) => (started = resolve)));
    const hook = setup();
    const pending = analyze(hook, "select 1; -- note");
    await act(async () => {});
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1", sql: "select 1" })
    );
    expect(runs(hook)[0]?.title).toBe("Explain Analyze 1");
    expect(record).not.toHaveBeenCalled();
    await act(async () => {
      started({ kind: "started", opId: "op-1" });
      await pending;
    });
    expect(record).toHaveBeenCalledWith("select 1", "explain_analyze");
    expect(runs(hook)[0]?.slots[0]).toMatchObject({
      status: "running",
      mode: "stream",
      opId: "op-1",
    });
  });

  it("records nothing when the backend refuses or is busy", async () => {
    mocks.start.mockResolvedValue({ kind: "busy" });
    const hook = setup();
    await act(() => analyze(hook));
    expect(record).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.slots[0]?.error).toBe(
      "Another Explain Analyze is still running on this connection."
    );
    // Released: a new attempt may start.
    mocks.start.mockResolvedValue({ kind: "started", opId: "op-1" });
    await act(() => analyze(hook));
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("stays running while silent, then shows the measured result", async () => {
    const hook = setup();
    await act(() => analyze(hook));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(runs(hook)[0]?.slots[0]?.status).toBe("running");
    await act(async () => {
      handlers!.onChunk({ columns: [{ name: "QUERY PLAN" }], rows: [["[]"]] });
      handlers!.onDone({ op_id: "op-1", row_count: 1 });
    });
    expect(runs(hook)[0]?.slots[0]?.status).toBe("done");
  });

  it("maps an error category to its fixed sentence", async () => {
    const hook = setup();
    await act(() => analyze(hook));
    await act(async () => {
      handlers!.onError({ op_id: "op-1", error: "lock_timeout" });
    });
    expect(runs(hook)[0]?.slots[0]?.error).toBe(
      "The statement waited more than 5 seconds for a lock held by another session and was stopped."
    );
  });

  it("never shows unknown server text", async () => {
    const hook = setup();
    await act(() => analyze(hook));
    await act(async () => {
      handlers!.onError({ op_id: "op-1", error: "secret row value 42" });
    });
    expect(runs(hook)[0]?.slots[0]?.error).toBe("The measurement failed.");
  });

  it("ends as no response after the watchdog", async () => {
    const hook = setup();
    await act(() => analyze(hook));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96_000);
    });
    expect(runs(hook)[0]?.slots[0]).toMatchObject({ status: "error" });
    expect(runs(hook)[0]?.slots[0]?.error).toMatch(/No response/);
  });

  it("keeps the whole attempt within the 100 s deadline", async () => {
    let started!: (value: unknown) => void;
    mocks.start.mockReturnValue(new Promise((resolve) => (started = resolve)));
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      started({ kind: "started", opId: "op-1" });
      await pending;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(71_000);
    });
    expect(runs(hook)[0]?.slots[0]?.error).toMatch(/No response/);
  });

  it("cancel while the start call is pending aborts the attempt", async () => {
    let signal!: AbortSignal;
    mocks.start.mockImplementation(
      (args: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal = args.signal;
          args.signal.addEventListener("abort", () =>
            resolve({ kind: "aborted" })
          );
        })
    );
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {});
    const runId = runs(hook)[0]!.id;
    await act(async () => {
      hook.result.current.cancelRun(runId);
      await pending;
    });
    expect(signal.aborted).toBe(true);
    expect(record).not.toHaveBeenCalled();
    expect(runs(hook)[0]?.slots[0]?.status).toBe("error");
  });

  it("cancels an id that arrives after the run was closed", async () => {
    let started!: (value: unknown) => void;
    mocks.start.mockReturnValue(new Promise((resolve) => (started = resolve)));
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {});
    await act(async () => {
      hook.result.current.closeRun(runs(hook)[0]!.id);
      started({ kind: "started", opId: "op-late" });
      await pending;
    });
    expect(mocks.cancel).toHaveBeenCalledWith("op-late");
    expect(record).not.toHaveBeenCalled();
    expect(runs(hook)).toHaveLength(0);
  });

  it("reset aborts a pending attempt", async () => {
    let signal!: AbortSignal;
    mocks.start.mockImplementation(
      (args: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal = args.signal;
          args.signal.addEventListener("abort", () =>
            resolve({ kind: "aborted" })
          );
        })
    );
    const hook = setup();
    const pending = analyze(hook);
    await act(async () => {});
    await act(async () => {
      hook.result.current.reset();
      await pending;
    });
    expect(signal.aborted).toBe(true);
    expect(runs(hook)).toHaveLength(0);
  });
});
