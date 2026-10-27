import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";
import { dumpRunGate, tabSafetyModeNow } from "./dumpRestoreSafety";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

describe("dumpRunGate", () => {
  it("refuses a whole dump in Lock and Production, whatever it holds", () => {
    expect(dumpRunGate("lock", "restore")).toEqual({
      kind: "blocked",
      message:
        "This tab is locked, so nothing was restored. Unlock it to restore a dump.",
    });
    expect(dumpRunGate("production", "import")).toMatchObject({
      kind: "blocked",
      message: expect.stringContaining("so nothing was imported"),
    });
  });

  it("says nothing more ran once statements already did", () => {
    expect(dumpRunGate("lock", "restore", true)).toMatchObject({
      message: expect.stringContaining("so nothing more was restored"),
    });
  });

  it("asks for Touch ID in Safe mode and runs in Default", () => {
    expect(dumpRunGate("safe", "restore")).toEqual({
      kind: "touch-id",
      prompt:
        "Authenticate with Touch ID to restore a dump into this database.",
    });
    expect(dumpRunGate("default", "restore").kind).toBe("run");
  });

  it("refuses once the tab is gone", () => {
    expect(dumpRunGate(null, "restore")).toMatchObject({
      kind: "blocked",
      message: "The connection tab was closed, so nothing was restored.",
    });
  });
});

describe("tabSafetyModeNow", () => {
  beforeEach(() => {
    useScreenStore.setState({
      profileTabs: [
        { id: "t1", querySafetyMode: "production" },
        { id: "t2", isLocked: true },
        { id: "t3" },
      ] as never,
    });
  });

  it("reads the tab's mode as it is now", () => {
    expect(tabSafetyModeNow("t1")).toBe("production");
    expect(tabSafetyModeNow("t2")).toBe("lock");
    expect(tabSafetyModeNow("t3")).toBe("default");
    expect(tabSafetyModeNow("gone")).toBeNull();
  });
});
