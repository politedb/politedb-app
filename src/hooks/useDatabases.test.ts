import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDatabases, type DatabaseChangeCheck } from "./useDatabases";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";
import { useScreenStore } from "src/stores/screen";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";

const m = vi.hoisted(() => ({ runSqlQuery: vi.fn() }));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.runSqlQuery }));

let inCheckTurn = false;

beforeEach(() => {
  resetTabRuntimes();
  seedTabRuntime({ tabId: "tab-1", runtimeId: "c1" });
  inCheckTurn = false;
  m.runSqlQuery.mockReset().mockImplementation(async (_id, sql: string) => {
    if (/DROP/.test(sql)) expect(inCheckTurn).toBe(true);
    return { rows: [] };
  });
});

function setup(check: DatabaseChangeCheck) {
  return renderHook(() =>
    useDatabases({
      open: false,
      engine: "postgres",
      runtimeConnectionId: "c1",
      tabId: "tab-1",
      beforeChange: () => check,
    })
  );
}

describe("useDatabases database changes", () => {
  it("sends the SQL in the same turn as the final check", async () => {
    const order: string[] = [];
    const { result } = setup({
      prepare: async () => {
        order.push("prepare");
        return null;
      },
      checkNow: () => {
        order.push("checkNow");
        inCheckTurn = true;
        queueMicrotask(() => (inCheckTurn = false));
        return null;
      },
    });
    await act(async () => {
      expect(await result.current.onDropDbByName("victim")).toBe(true);
    });
    expect(order).toEqual(["prepare", "checkNow"]);
    expect(m.runSqlQuery).toHaveBeenCalledWith(
      "c1",
      expect.stringContaining('DROP DATABASE "victim"')
    );
  });

  it.each<[string, DatabaseChangeCheck]>([
    ["prepare", { prepare: async () => "no", checkNow: () => null }],
    ["checkNow", { prepare: async () => null, checkNow: () => "no" }],
  ])("sends nothing when %s refuses", async (_, check) => {
    const { result } = setup(check);
    await act(async () => {
      expect(await result.current.onDropDbByName("victim")).toBe(false);
    });
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(result.current.error).toBe("no");
  });
});

describe("useDatabases tab guard (D3)", () => {
  const allow: DatabaseChangeCheck = {
    prepare: async () => null,
    checkNow: () => null,
  };

  it.each<[string, () => void]>([
    [
      "the tab's target is unknown",
      () =>
        useScreenStore.getState().updateTab("tab-1", {
          target: { kind: "unknown" },
        }),
    ],
    [
      "the connection has no recorded identity",
      () => useRuntimeTargetsStore.getState().register("c1", null, "tab-1"),
    ],
    [
      "the connection is opened on another database",
      () =>
        useScreenStore.getState().updateTab("tab-1", {
          target: { kind: "override", database: "other" },
        }),
    ],
    [
      "the tab now uses another connection",
      () =>
        useScreenStore
          .getState()
          .updateTab("tab-1", { runtimeConnectionId: "c2" }),
    ],
  ])("sends nothing when %s", async (_, change) => {
    change();
    const { result } = setup(allow);
    await act(async () => {
      expect(await result.current.onDropDbByName("victim")).toBe(false);
    });
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/Reconnect|could not be determined/);
  });

  it("sends nothing when the tab reconnects during the checks' waits", async () => {
    const { result } = setup({
      prepare: async () => {
        // Touch ID is open; the tab gets another connection meanwhile.
        seedTabRuntime({ tabId: "tab-1", runtimeId: "c2" });
        return null;
      },
      checkNow: () => null,
    });
    await act(async () => {
      expect(await result.current.onDropDbByName("victim")).toBe(false);
    });
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/no longer uses this connection/);
  });
});
