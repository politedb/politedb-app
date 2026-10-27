import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";
import { dumpRunGate, tabSafetyModeNow } from "./dumpRestoreSafety";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const writes = ["CREATE TABLE a (id int)", "INSERT INTO a VALUES (1)"];
const reads = ["SELECT 1"];

describe("dumpRunGate", () => {
  it("blocks writes in Lock and Production, as the SQL editor does", () => {
    expect(dumpRunGate("lock", writes, "restore")).toMatchObject({
      kind: "blocked",
      message: expect.stringContaining("locked"),
    });
    expect(dumpRunGate("production", writes, "import")).toMatchObject({
      kind: "blocked",
      message: expect.stringContaining("nothing was imported"),
    });
  });

  it("assumes a dump writes before it is read", () => {
    expect(dumpRunGate("production", null, "restore").kind).toBe("blocked");
    expect(dumpRunGate("lock", null, "restore").kind).toBe("blocked");
    expect(dumpRunGate("safe", null, "restore").kind).toBe("touch-id");
    expect(dumpRunGate("default", null, "restore").kind).toBe("run");
  });

  it("asks for Touch ID in Safe mode, and for reads in Production", () => {
    expect(dumpRunGate("safe", writes, "restore")).toEqual({
      kind: "touch-id",
      prompt:
        "Authenticate with Touch ID to restore a dump into this database.",
    });
    expect(dumpRunGate("production", reads, "restore").kind).toBe("touch-id");
    expect(dumpRunGate("lock", reads, "restore").kind).toBe("run");
  });

  it("runs in Default mode and refuses once the tab is gone", () => {
    expect(dumpRunGate("default", writes, "restore").kind).toBe("run");
    expect(dumpRunGate(null, writes, "restore")).toMatchObject({
      kind: "blocked",
      message: "The connection tab was closed: nothing was restored.",
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
