import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  runSqlQuery: vi.fn(),
  startSqlQueryStream: vi.fn(),
}));
vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: m.runSqlQuery,
  startSqlQueryStream: m.startSqlQueryStream,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useSqlHistoryRunner } from "./useSqlHistoryRunner";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

const historyOf = (tabId: string) =>
  (useConnectionStore.getState().queryHistory?.[tabId] ?? []) as unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  m.startSqlQueryStream.mockResolvedValue("op-1");
  resetTabRuntimes();
  useConnectionStore.setState({ queryHistory: {} } as never);
  // Two tabs on different databases, and a third on A's database.
  seedTabRuntime({ tabId: "a", runtimeId: "ra" });
  seedTabRuntime({
    tabId: "b",
    runtimeId: "rb",
    target: { kind: "override", database: "other" },
  });
  seedTabRuntime({ tabId: "c", runtimeId: "rc" });
  useScreenStore.setState({ activeProfileScreen: "a" });
});

function run(tabId: string, connectionId: string) {
  const { result } = renderHook(() => useSqlHistoryRunner());
  return act(async () => {
    await result.current.runSqlWithHistory({
      tabId,
      connectionId,
      sql: "select 1",
    });
  });
}

describe("SQL work belongs to the tab it started in (D3)", () => {
  it("runs on the tab's own connection", async () => {
    await run("a", "ra");
    expect(m.startSqlQueryStream).toHaveBeenCalledWith("ra", "select 1");
  });

  it.each([
    ["another tab's connection on another database", "rb"],
    ["another tab's connection on the same database", "rc"],
  ])("sends nothing through %s", async (_, connectionId) => {
    await expect(run("a", connectionId)).rejects.toThrow(
      "no longer uses this connection"
    );
    expect(m.startSqlQueryStream).not.toHaveBeenCalled();
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(historyOf("a")).toHaveLength(0);
  });

  it("keeps running a tab's work after another tab became active", async () => {
    useScreenStore.setState({ activeProfileScreen: "b" });
    await run("a", "ra");
    expect(m.startSqlQueryStream).toHaveBeenCalledWith("ra", "select 1");
    expect(historyOf("a")).toHaveLength(1);
    expect(historyOf("b")).toHaveLength(0);
  });

  it("sends nothing on a tab whose target became unknown", async () => {
    useScreenStore.getState().updateTab("a", { target: { kind: "unknown" } });
    await expect(run("a", "ra")).rejects.toThrow("could not be determined");
    expect(m.startSqlQueryStream).not.toHaveBeenCalled();
  });
});
