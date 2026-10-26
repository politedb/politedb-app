import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { windowIdForDraftKey } from "src/lib/objectDraftKey";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import type { OpenWindow } from "src/types";
import { clearConnectionTabChanges, connectionTabHasChanges } from "./tabDirty";
import {
  discardAllConnectionChanges,
  hasAnyUnsavedConnectionChanges,
} from "./unsavedChanges";
import { useConnectionStore } from "src/stores/connection";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const NEW = "new:function:a";
const fn = buildDatabaseObjectItem({
  engine: "postgres",
  kind: "function",
  schema: "public",
  name: "calc",
  signature: "",
});
const drafts = () => useObjectDraftStore.getState();

function seedClosedCreate(tab: string) {
  drafts().ensureCreateDraft(tab, NEW, {
    kind: "function",
    form: { schema: "public", name: "f", tableName: "" },
    sql: "",
  });
}

beforeEach(() => {
  drafts().clearAll();
  useScreenStore.setState({ openWindows: {}, activeWindowId: {} });
  useConnectionStore.setState({
    dirtyStateByScreen: { t1: { hasAnyChanges: false } },
  } as never);
});

describe("unsaved object work outside open windows", () => {
  it("a closed create with empty SQL still warns on tab close and quit", () => {
    seedClosedCreate("t1");
    // A cached "no changes" for tables does not hide object work.
    expect(connectionTabHasChanges("t1")).toBe(true);
    expect(connectionTabHasChanges("t2")).toBe(false);
    expect(hasAnyUnsavedConnectionChanges()).toBe(true);
  });

  it("a clean edit draft does not warn", () => {
    drafts().ensureEditDraft("t1", `obj:${fn.id}`, fn);
    expect(connectionTabHasChanges("t1")).toBe(false);
    expect(hasAnyUnsavedConnectionChanges()).toBe(false);
  });

  it("clearing a tab drops only its drafts", () => {
    seedClosedCreate("t1");
    seedClosedCreate("t2");
    clearConnectionTabChanges("t1");
    expect(drafts().drafts.t1).toBeUndefined();
    expect(drafts().drafts.t2?.[NEW]).toBeTruthy();
  });

  it("discard all drops every draft and closes create windows only", () => {
    seedClosedCreate("t1");
    drafts().ensureEditDraft("t2", `obj:${fn.id}`, fn);
    const createWin = {
      id: windowIdForDraftKey(NEW),
      type: "db-object-manager",
      initialObjectId: "",
    } as OpenWindow;
    const editWin = {
      id: windowIdForDraftKey(`obj:${fn.id}`),
      type: "db-object-manager",
      initialObjectId: fn.id,
    } as OpenWindow;
    useScreenStore.setState({
      openWindows: { t1: [createWin], t2: [editWin] },
      activeWindowId: { t1: createWin.id, t2: editWin.id },
    });
    discardAllConnectionChanges();
    expect(drafts().drafts).toEqual({});
    expect(useScreenStore.getState().openWindows.t1).toEqual([]);
    expect(useScreenStore.getState().openWindows.t2).toEqual([editWin]);
    expect(hasAnyUnsavedConnectionChanges()).toBe(false);
  });
});
