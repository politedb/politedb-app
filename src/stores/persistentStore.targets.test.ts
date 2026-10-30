import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  load: vi.fn(),
  list: vi.fn(),
}));

vi.mock("src/lib/tauri/persistent", () => ({
  persistentLoad: m.load,
  persistentSave: vi.fn(async () => {}),
  persistentClear: vi.fn(async () => {}),
}));
vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  profileList: m.list,
}));

import { usePersistentStore } from "./persistentStore";
import { useScreenStore } from "./screen";

const profile = {
  id: "p1",
  label: "team · prod",
  engine: "postgres",
  input: { engine: "postgres", postgres: { database: "app" } },
  created_at: 0,
  updated_at: 0,
  revision: "r1",
};

function snapshot(profileTabs: unknown[], openWindows: object = {}) {
  return {
    version: 1,
    savedAt: Date.now(),
    activeProfileScreen: "main",
    profileTabs,
    openWindows,
    activeWindowId: {},
  };
}

beforeEach(() => {
  m.list.mockResolvedValue([profile]);
  usePersistentStore.setState({ restoredOnce: false } as never);
  useScreenStore.setState({ profileTabs: [], openWindows: {} } as never);
});

describe("restoring tabs (R11, R12)", () => {
  it("makes every tab saved before targets were recorded unknown, labels ignored", async () => {
    m.load.mockResolvedValue(
      snapshot([
        // A default tab of a profile whose label has a separator.
        { id: "a", label: "team · prod", engine: "postgres", profileId: "p1" },
        // A legacy "Open database" tab with its override saved.
        {
          id: "b",
          label: "team · prod · x",
          engine: "postgres",
          profileId: "p1",
          databaseOverride: "x",
        },
        // Recorded tabs keep what they recorded, the mirror is rewritten.
        {
          id: "c",
          label: "c",
          engine: "postgres",
          profileId: "p1",
          target: { kind: "override", database: "y" },
          databaseOverride: "stale",
        },
        {
          id: "d",
          label: "d",
          engine: "postgres",
          profileId: "p1",
          target: { kind: "default" },
        },
        {
          id: "e",
          label: "e",
          engine: "postgres",
          profileId: "p1",
          target: { kind: "nope" },
        },
      ])
    );
    await usePersistentStore.getState().restore();
    const tabs = Object.fromEntries(
      useScreenStore.getState().profileTabs.map((t) => [t.id, t])
    );
    expect(tabs.a?.target).toEqual({ kind: "unknown" });
    expect(tabs.b?.target).toEqual({ kind: "unknown" });
    expect(tabs.b?.databaseOverride).toBeUndefined();
    expect(tabs.c?.target).toEqual({ kind: "override", database: "y" });
    expect(tabs.c?.databaseOverride).toBe("y");
    expect(tabs.d?.target).toEqual({ kind: "default" });
    expect(tabs.e?.target).toEqual({ kind: "unknown" });
  });

  it("never restores a runtime connection handle of a window", async () => {
    m.load.mockResolvedValue(
      snapshot(
        [
          {
            id: "d",
            label: "d",
            engine: "postgres",
            profileId: "p1",
            target: { kind: "default" },
          },
        ],
        {
          d: [
            {
              id: "w1",
              type: "table",
              table: { schema: "public", name: "t" },
              connectionId: "old-runtime",
            },
          ],
        }
      )
    );
    await usePersistentStore.getState().restore();
    const [window] = useScreenStore.getState().openWindows.d ?? [];
    expect(window).toBeDefined();
    expect(window).not.toHaveProperty("connectionId");
  });
});
