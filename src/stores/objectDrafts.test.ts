import { beforeEach, describe, expect, it } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import {
  anyTabHasPendingObjectWork,
  canExecute,
  hasPendingWork,
  tabHasPendingObjectWork,
  useObjectDraftStore,
} from "./objectDrafts";

const fn = buildDatabaseObjectItem({
  engine: "postgres",
  kind: "function",
  schema: "public",
  name: "calc",
  signature: "",
});
const EDIT = `obj:${fn.id}`;
const NEW = "new:function:a";

const store = () => useObjectDraftStore.getState();
const draft = (tab: string, key: string) => store().drafts[tab]?.[key];

function loadEdit(tab = "t1", sql = "CREATE FUNCTION calc() v1") {
  store().ensureEditDraft(tab, EDIT, fn);
  store().applyDefinition(tab, EDIT, draft(tab, EDIT)!.generation, sql, fn);
}

function seedCreate(tab = "t1") {
  store().ensureCreateDraft(tab, NEW, {
    kind: "function",
    form: { schema: "public", name: "new_function", tableName: "" },
    sql: "CREATE FUNCTION new_function()",
  });
}

beforeEach(() => store().clearAll());

describe("object draft predicates", () => {
  it("a create is pending until saved or discarded, even untouched or empty", () => {
    seedCreate();
    expect(hasPendingWork(draft("t1", NEW)!)).toBe(true);
    store().setSql("t1", NEW, "   ");
    expect(hasPendingWork(draft("t1", NEW)!)).toBe(true);
    // Empty SQL is kept but never runs.
    expect(canExecute(draft("t1", NEW)!)).toBe(false);
  });

  it("an edit is pending only once loaded and different (trimmed)", () => {
    store().ensureEditDraft("t1", EDIT, fn);
    expect(hasPendingWork(draft("t1", EDIT)!)).toBe(false);
    loadEdit();
    store().setSql("t1", EDIT, "CREATE FUNCTION calc() v1  \n");
    expect(hasPendingWork(draft("t1", EDIT)!)).toBe(false);
    store().setSql("t1", EDIT, "CREATE FUNCTION calc() v2");
    expect(hasPendingWork(draft("t1", EDIT)!)).toBe(true);
    expect(canExecute(draft("t1", EDIT)!)).toBe(true);
  });

  it("tab scope: the same object in two tabs keeps two drafts", () => {
    loadEdit("t1");
    loadEdit("t2");
    store().setSql("t1", EDIT, "changed");
    expect(tabHasPendingObjectWork("t1")).toBe(true);
    expect(tabHasPendingObjectWork("t2")).toBe(false);
    store().clearTab("t1");
    expect(draft("t1", EDIT)).toBeUndefined();
    expect(draft("t2", EDIT)).toBeTruthy();
    expect(anyTabHasPendingObjectWork()).toBe(false);
  });
});

describe("object draft actions", () => {
  it("a create is read-only while saving", () => {
    seedCreate();
    store().setSaving("t1", NEW, true);
    store().setSql("t1", NEW, "other");
    store().setCreateFields("t1", NEW, { form: { name: "x" } });
    expect(draft("t1", NEW)!.sql).toBe("CREATE FUNCTION new_function()");
    expect(draft("t1", NEW)!.form.name).toBe("new_function");
    expect(canExecute(draft("t1", NEW)!)).toBe(false);
  });

  it("a fetched definition refreshes a clean edit and flags a dirty one", () => {
    loadEdit();
    const gen = draft("t1", EDIT)!.generation;
    store().applyDefinition("t1", EDIT, gen, "v2", fn);
    expect(draft("t1", EDIT)!.sql).toBe("v2");

    store().setSql("t1", EDIT, "mine");
    store().applyDefinition("t1", EDIT, gen, "v3", fn);
    expect(draft("t1", EDIT)!.sql).toBe("mine");
    expect(draft("t1", EDIT)!.baselineSql).toBe("v2");
    expect(draft("t1", EDIT)!.conflict).toBe(true);
  });

  it("ignores a definition for an older generation", () => {
    loadEdit();
    const old = draft("t1", EDIT)!.generation;
    store().revert("t1", EDIT);
    store().applyDefinition("t1", EDIT, old, "stale", fn);
    expect(draft("t1", EDIT)!.sql).toBe("CREATE FUNCTION calc() v1");
  });

  it("markSaved keeps text typed during the save pending", () => {
    loadEdit();
    store().setSql("t1", EDIT, "submitted");
    const gen = draft("t1", EDIT)!.generation;
    store().setSql("t1", EDIT, "typed later");
    store().markSaved("t1", EDIT, gen, "submitted");
    expect(draft("t1", EDIT)!.baselineSql).toBe("submitted");
    expect(hasPendingWork(draft("t1", EDIT)!)).toBe(true);
  });

  it("revert restores the baseline with a new generation", () => {
    loadEdit();
    const gen = draft("t1", EDIT)!.generation;
    store().setSql("t1", EDIT, "mine");
    store().revert("t1", EDIT);
    expect(draft("t1", EDIT)!.sql).toBe("CREATE FUNCTION calc() v1");
    expect(draft("t1", EDIT)!.generation).not.toBe(gen);
  });

  it("syncMissing drops clean missing edits, flags dirty ones, clears on return", () => {
    loadEdit();
    store().syncMissing("t1", new Set());
    expect(draft("t1", EDIT)).toBeUndefined();

    loadEdit();
    store().setSql("t1", EDIT, "mine");
    store().syncMissing("t1", new Set());
    expect(draft("t1", EDIT)!.missing).toBe(true);
    expect(canExecute(draft("t1", EDIT)!)).toBe(false);
    store().syncMissing("t1", new Set([fn.id]));
    expect(draft("t1", EDIT)!.missing).toBe(false);
  });

  it("syncMissing leaves creates alone", () => {
    seedCreate();
    store().syncMissing("t1", new Set());
    expect(draft("t1", NEW)).toBeTruthy();
  });
});
