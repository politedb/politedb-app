import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenWindow } from "src/types";
import { activeAfterClose, useScreenStore } from "./screen";
import { useObjectDraftStore } from "./objectDrafts";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
// Tab lifecycle logs sessions after a microtask; keep that inside the test.
vi.mock("src/stores/connectionLog", () => ({
  useConnectionLogStore: {
    getState: () => new Proxy({}, { get: () => () => {} }),
  },
}));

const win = (id: string) =>
  ({ id, type: "sql", title: id }) as unknown as OpenWindow;
const ids = (list: string[]) => list.map(win);

describe("activeAfterClose", () => {
  const all = ids(["A", "B", "C", "D"]);
  it("keeps a surviving active window", () => {
    expect(activeAfterClose(all, new Set(["D"]), "C")).toBe("C");
    // Close to the Right of A while C is active ends on A.
    expect(activeAfterClose(all, new Set(["B", "C", "D"]), "C")).toBe("A");
  });
  it("prefers the right neighbor, then the left one", () => {
    expect(activeAfterClose(all, new Set(["B"]), "B")).toBe("C");
    expect(activeAfterClose(all, new Set(["D"]), "D")).toBe("C");
    expect(activeAfterClose(all, new Set(["B", "C"]), "B")).toBe("D");
  });
  it("is null when nothing survives", () => {
    expect(activeAfterClose(all, new Set(["A", "B", "C", "D"]), "A")).toBe(
      null
    );
  });
});

describe("screen store windows", () => {
  beforeEach(() => {
    useScreenStore.setState({
      openWindows: { t1: ids(["A", "B", "C", "D"]) },
      activeWindowId: { t1: "B" },
      profileTabs: [],
      tabEpoch: {},
    });
  });

  it("removes several windows in one transition", () => {
    useScreenStore.getState().removeWindows("t1", ["A", "B", "C"]);
    const s = useScreenStore.getState();
    expect(s.openWindows.t1!.map((w) => w.id)).toEqual(["D"]);
    expect(s.activeWindowId.t1).toBe("D");
  });

  it("ignores unknown ids without moving focus", () => {
    const before = useScreenStore.getState();
    useScreenStore.getState().removeWindows("t1", ["Z"]);
    expect(useScreenStore.getState()).toBe(before);
  });

  it("bumps a tab's epoch on reconnect and removal, never down", () => {
    const tab = {
      id: "t9",
      label: "x",
      profileId: "p",
      engine: "postgres",
      runtimeConnectionId: "c1",
    } as never;
    useScreenStore.getState().addTab(tab);
    const e0 = useScreenStore.getState().tabEpoch.t9 ?? 0;
    useScreenStore.getState().updateTab("t9", { runtimeConnectionId: "c2" });
    const e1 = useScreenStore.getState().tabEpoch.t9!;
    expect(e1).toBeGreaterThan(e0);
    useScreenStore.getState().removeTab("t9");
    expect(useScreenStore.getState().tabEpoch.t9!).toBeGreaterThan(e1);
  });

  it("ends a tab's object drafts with it, and only its own", () => {
    const drafts = useObjectDraftStore.getState();
    drafts.clearAll();
    const seed = (tab: string) =>
      drafts.ensureCreateDraft(tab, "new:function:a", {
        kind: "function",
        form: { schema: "public", name: "f", tableName: "" },
        sql: "",
      });
    const tab = (id: string) =>
      ({ id, label: id, profileId: "p", engine: "postgres" }) as never;
    useScreenStore.setState({ profileTabs: [tab("a"), tab("b")] });
    seed("a");
    seed("b");
    useScreenStore.getState().removeTab("a");
    expect(useObjectDraftStore.getState().drafts.a).toBeUndefined();
    expect(useObjectDraftStore.getState().drafts.b).toBeTruthy();

    // A reset starts new lifetimes, also for a tab that keeps its id.
    useScreenStore.getState().resetTabs([tab("b")]);
    expect(useObjectDraftStore.getState().drafts).toEqual({});
  });
});
