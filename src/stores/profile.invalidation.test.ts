import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(async () => {}) }));

vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  profileList: m.list,
  profileRemove: m.remove,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useProfileStore } from "./profile";
import { useScreenStore } from "./screen";

const profile = (id: string, revision: string) =>
  ({
    id,
    label: id,
    engine: "postgres",
    input: { engine: "postgres", postgres: { database: "app" } },
    created_at: 0,
    updated_at: 0,
    revision,
  }) as never;

const epoch = (tabId: string) => useScreenStore.getState().tabEpoch[tabId] ?? 0;

beforeEach(async () => {
  useScreenStore.setState({
    profileTabs: [
      {
        id: "x1",
        profileId: "x",
        engine: "postgres",
        target: { kind: "default" },
      },
      {
        id: "y1",
        profileId: "y",
        engine: "postgres",
        target: { kind: "default" },
      },
    ] as never,
    tabEpoch: {},
  });
  m.list.mockResolvedValue([profile("x", "a"), profile("y", "a")]);
  await useProfileStore.getState().loadProfiles();
});

describe("observed profile changes (R16)", () => {
  it("invalidates the tabs of a profile whose revision changed, before publishing it", async () => {
    const [x, y] = [epoch("x1"), epoch("y1")];
    let seenAtPublish = -1;
    const unsubscribe = useProfileStore.subscribe((s) => {
      if (s.profiles.some((p) => p.id === "x" && p.revision === "b")) {
        seenAtPublish = epoch("x1");
      }
    });
    await useProfileStore.getState().saveProfile(profile("x", "b"));
    unsubscribe();
    expect(epoch("x1")).toBe(x + 1);
    expect(seenAtPublish).toBe(x + 1);
    // Other profiles untouched; the same revision again changes nothing.
    expect(epoch("y1")).toBe(y);
    await useProfileStore.getState().saveProfile(profile("x", "b"));
    expect(epoch("x1")).toBe(x + 1);
  });

  it("only ever invalidates: a late list carrying an older revision is one more invalidation", async () => {
    await useProfileStore.getState().saveProfile(profile("x", "b"));
    const after = epoch("x1");
    m.list.mockResolvedValue([profile("x", "a"), profile("y", "a")]);
    await useProfileStore.getState().loadProfiles();
    expect(epoch("x1")).toBe(after + 1);
  });

  it("invalidates the tabs of a removed profile", async () => {
    const before = epoch("y1");
    await useProfileStore.getState().removeProfile("y");
    expect(epoch("y1")).toBe(before + 1);
    // Missing from a later list too.
    const x = epoch("x1");
    m.list.mockResolvedValue([]);
    await useProfileStore.getState().loadProfiles();
    expect(epoch("x1")).toBe(x + 1);
  });
});

describe("publishing a list a mutation returned (R16)", () => {
  it("invalidates the changed profiles' tabs at once, before any later list", async () => {
    const x = epoch("x1");
    useProfileStore
      .getState()
      .publishProfiles([profile("x", "imported"), profile("y", "a")]);
    expect(epoch("x1")).toBe(x + 1);
    expect(useProfileStore.getState().getProfileById("x")?.revision).toBe(
      "imported"
    );
    // The refresh afterwards carries the same revision: nothing more.
    m.list.mockResolvedValue([profile("x", "imported"), profile("y", "a")]);
    await useProfileStore.getState().loadProfiles();
    expect(epoch("x1")).toBe(x + 1);
  });
});

describe("tab labels follow a renamed profile", () => {
  const labelOf = (tabId: string) =>
    useScreenStore.getState().profileTabs.find((t) => t.id === tabId)?.label;

  it("relabels every tab of the profile, wherever it was saved", async () => {
    useScreenStore.setState((s) => ({
      profileTabs: [
        ...s.profileTabs,
        {
          id: "x2",
          profileId: "x",
          engine: "postgres",
          label: "Athenaa · demo_db",
          target: { kind: "override", database: "demo_db" },
        },
        {
          id: "x3",
          profileId: "x",
          engine: "postgres",
          label: "Athenaa · old",
          target: { kind: "unknown" },
        },
      ] as never,
    }));
    m.list.mockResolvedValue([
      { ...(profile("x", "b") as object), label: "Athena" },
      profile("y", "a"),
    ]);
    await useProfileStore.getState().loadProfiles();
    expect(labelOf("x1")).toBe("Athena");
    expect(labelOf("x2")).toBe("Athena · demo_db");
    // An unknown tab keeps its label: the only hint of its database.
    expect(labelOf("x3")).toBe("Athenaa · old");
    expect(labelOf("y1")).not.toBe("Athena");
  });
});
