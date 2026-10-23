import { renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => {
  const addQueryHistory = vi.fn();
  const screen = {
    profileTabs: [
      { id: "tab-1", label: "Local PG", runtimeConnectionId: "rt-1" },
      { id: "tab-2", label: "Other", runtimeConnectionId: "rt-2" },
    ],
    activeProfileScreen: "tab-1",
  };
  const useConnectionStore = Object.assign(() => ({ addQueryHistory }), {
    getState: () => ({ addQueryHistory }),
  });
  const useScreenStore = Object.assign(() => screen, {
    getState: () => screen,
  });
  return { addQueryHistory, screen, useConnectionStore, useScreenStore };
});
vi.mock("src/stores/connection", () => ({
  useConnectionStore: stores.useConnectionStore,
}));
vi.mock("src/stores/screen", () => ({
  useScreenStore: stores.useScreenStore,
}));
vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: vi.fn(),
  startSqlQueryStream: vi.fn(),
}));

import { useSqlHistoryRunner } from "./useSqlHistoryRunner";

describe("captureHistoryTarget", () => {
  beforeEach(() => {
    stores.addQueryHistory.mockReset();
    stores.screen.activeProfileScreen = "tab-1";
    stores.screen.profileTabs = [
      { id: "tab-1", label: "Local PG", runtimeConnectionId: "rt-1" },
      { id: "tab-2", label: "Other", runtimeConnectionId: "rt-2" },
    ];
  });

  it("writes to the tab active at capture time", () => {
    const hook = renderHook(() => useSqlHistoryRunner());
    const target = hook.result.current.captureHistoryTarget();
    expect(target?.label).toBe("Local PG");
    expect(target?.tabId).toBe("tab-1");
    expect(target?.isCurrent()).toBe(true);

    stores.screen.activeProfileScreen = "tab-2";
    target?.record("select 1", "explain_analyze");
    expect(stores.addQueryHistory).toHaveBeenCalledWith("tab-1", "select 1", {
      kind: "explain_analyze",
    });
  });

  it("drops the write when that tab was closed", () => {
    const hook = renderHook(() => useSqlHistoryRunner());
    const target = hook.result.current.captureHistoryTarget();
    stores.screen.profileTabs = [
      { id: "tab-2", label: "Other", runtimeConnectionId: "rt-2" },
    ];
    target?.record("select 1", "explain_analyze");
    expect(stores.addQueryHistory).not.toHaveBeenCalled();
  });

  it("drops the write when the tab moved to another connection", () => {
    const hook = renderHook(() => useSqlHistoryRunner());
    const target = hook.result.current.captureHistoryTarget();
    stores.screen.profileTabs = [
      { id: "tab-1", label: "Local PG", runtimeConnectionId: "rt-9" },
    ];
    target?.record("select 1", "explain_analyze");
    expect(stores.addQueryHistory).not.toHaveBeenCalled();
  });

  it("is null on the main screen", () => {
    stores.screen.activeProfileScreen = "main";
    const hook = renderHook(() => useSqlHistoryRunner());
    expect(hook.result.current.captureHistoryTarget()).toBeNull();
  });
});
