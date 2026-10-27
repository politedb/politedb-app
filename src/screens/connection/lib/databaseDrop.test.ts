import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileStore } from "src/stores/profile";
import { useScreenStore } from "src/stores/screen";
import {
  beforeDatabaseChange,
  describeDropError,
  dropFromOwnDatabase,
  tabDatabase,
  tabsOnDatabase,
} from "./databaseDrop";

const m = vi.hoisted(() => ({
  touchId: vi.fn(),
  close: vi.fn(),
}));
vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: m.touchId,
}));
vi.mock("./connectionTabClose", () => ({
  requestCloseConnectionTab: m.close,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

function setTabs(tabs: Array<Record<string, unknown>>) {
  useScreenStore.setState({ profileTabs: tabs as never });
}

beforeEach(() => {
  m.touchId.mockReset().mockResolvedValue(undefined);
  m.close.mockReset().mockImplementation(async (id: string) => {
    setTabs(
      useScreenStore.getState().profileTabs.filter((tab) => tab.id !== id)
    );
  });
  useProfileStore.setState({
    profiles: [
      {
        id: "p1",
        label: "Athena",
        engine: "postgres",
        input: { engine: "postgres", postgres: { database: "app" } },
      },
      {
        id: "p2",
        label: "Other",
        engine: "postgres",
        input: { engine: "postgres", postgres: { database: "test1" } },
      },
    ] as never,
  });
  setTabs([
    { id: "home", profileId: "p1", label: "Athena" },
    {
      id: "t1",
      profileId: "p1",
      label: "Athena · test1",
      databaseOverride: "test1",
    },
    { id: "t1b", profileId: "p1", label: "Athena · test1" },
    { id: "other", profileId: "p2", label: "Other" },
  ]);
});

describe("the database a tab uses", () => {
  it("reads the override, the tab label, then the profile", () => {
    expect(tabDatabase("home")).toBe("app");
    expect(tabDatabase("t1")).toBe("test1");
    expect(tabDatabase("t1b")).toBe("test1");
    expect(tabDatabase("gone")).toBe("");
    // Only tabs of the same saved connection.
    expect(tabsOnDatabase("p1", "test1")).toEqual(["t1", "t1b"]);
  });
});

describe("dropping a database", () => {
  it("refuses to drop the database the tab is in (PostgreSQL, SQL Server)", async () => {
    expect(dropFromOwnDatabase("t1", "postgres", "test1")).toContain(
      'This tab is connected to "test1"'
    );
    expect(dropFromOwnDatabase("t1", "postgres", "app")).toBeNull();
    // MySQL drops the current database fine.
    expect(dropFromOwnDatabase("t1", "mysql", "test1")).toBeNull();
    expect(
      await beforeDatabaseChange("t1", "p1", "postgres", {
        kind: "drop",
        name: "test1",
      })
    ).toContain("Open another database");
    expect(m.close).not.toHaveBeenCalled();
  });

  it("closes the connection's other tabs on that database first", async () => {
    expect(
      await beforeDatabaseChange("home", "p1", "postgres", {
        kind: "drop",
        name: "test1",
      })
    ).toBeNull();
    expect(m.close.mock.calls.map((call) => call[0])).toEqual(["t1", "t1b"]);
    expect(useScreenStore.getState().profileTabs.map((t) => t.id)).toEqual([
      "home",
      "other",
    ]);
  });

  it("stops when a tab on that database stays open (unsaved changes)", async () => {
    m.close.mockResolvedValue(undefined);
    expect(
      await beforeDatabaseChange("home", "p1", "postgres", {
        kind: "drop",
        name: "test1",
      })
    ).toContain("unsaved changes");
  });

  it("explains other sessions holding the database", () => {
    const message = describeDropError(
      'database "test1" is being accessed by other users\nDETAIL: There is 1 other session using the database.',
      "test1"
    );
    expect(message).toMatch(/^Other sessions are still connected to "test1"/);
    expect(message).toContain("There is 1 other session");
    expect(describeDropError("permission denied", "test1")).toBe(
      "permission denied"
    );
  });
});

describe("the safety mode", () => {
  it.each([
    ["lock", { isLocked: true }],
    ["production", { querySafetyMode: "production" }],
  ])("%s refuses every database change", async (_, mode) => {
    setTabs([{ id: "home", profileId: "p1", label: "Athena", ...mode }]);
    for (const change of [
      { kind: "create", name: "x" },
      { kind: "rename", name: "x", to: "y" },
      { kind: "drop", name: "test1" },
    ] as const) {
      expect(
        await beforeDatabaseChange("home", "p1", "postgres", change)
      ).toBeTruthy();
    }
    expect(m.close).not.toHaveBeenCalled();
    expect(m.touchId).not.toHaveBeenCalled();
  });

  it("asks for Touch ID in Safe mode, before closing any tab", async () => {
    setTabs([
      { id: "home", profileId: "p1", label: "Athena", querySafetyMode: "safe" },
      { id: "t1", profileId: "p1", databaseOverride: "test1" },
    ]);
    m.touchId.mockRejectedValueOnce(new Error("cancelled"));
    expect(
      await beforeDatabaseChange("home", "p1", "postgres", {
        kind: "drop",
        name: "test1",
      })
    ).toContain("Touch ID was not confirmed");
    expect(m.close).not.toHaveBeenCalled();

    expect(
      await beforeDatabaseChange("home", "p1", "postgres", {
        kind: "drop",
        name: "test1",
      })
    ).toBeNull();
    expect(m.touchId).toHaveBeenCalledTimes(2);
    expect(m.close).toHaveBeenCalledWith("t1");
  });

  it("runs in Default mode without Touch ID", async () => {
    expect(
      await beforeDatabaseChange("home", "p1", "postgres", {
        kind: "create",
        name: "x",
      })
    ).toBeNull();
    expect(m.touchId).not.toHaveBeenCalled();
  });
});
