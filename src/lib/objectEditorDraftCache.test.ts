import { beforeEach, describe, expect, it } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import {
  collectObjectChangeSummary,
  collectPendingObjectSaveEntries,
  collectPendingObjectSql,
  collectObjectSaveNotices,
  collectSkippedObjectDrafts,
} from "./objectEditorDraftCache";

const fn = buildDatabaseObjectItem({
  engine: "postgres",
  kind: "function",
  schema: "public",
  name: "calc",
  signature: "",
});
const store = () => useObjectDraftStore.getState();

function seed() {
  store().ensureCreateDraft("t1", "new:procedure:a", {
    kind: "procedure",
    form: { schema: "public", name: "p1", tableName: "" },
    sql: "CREATE PROCEDURE p1() LANGUAGE sql AS $$ SELECT 1 $$",
  });
  store().ensureEditDraft("t1", `obj:${fn.id}`, fn);
  const gen = store().drafts.t1![`obj:${fn.id}`]!.generation;
  store().applyDefinition("t1", `obj:${fn.id}`, gen, "CREATE FUNCTION v1", fn);
  store().setSql("t1", `obj:${fn.id}`, "CREATE OR REPLACE FUNCTION v2");
}

beforeEach(() => store().clearAll());

describe("object draft collectors", () => {
  it("collect every draft of the tab once, without any window", () => {
    seed();
    const entries = collectPendingObjectSaveEntries({
      tabId: "t1",
      engine: "postgres",
    });
    expect(entries.map((e) => e.mode).sort()).toEqual(["create", "edit"]);
    expect(
      collectPendingObjectSql({ tabId: "t1", engine: "postgres" })
    ).toEqual(entries.flatMap((e) => e.statements));
    expect(
      collectPendingObjectSql({ tabId: "t2", engine: "postgres" })
    ).toEqual([]);
  });

  it("summarize by draft mode, not by SQL text", () => {
    seed();
    expect(
      collectObjectChangeSummary({ tabId: "t1", engine: "postgres" })
    ).toMatchObject({ insertProcedures: 1, updateFunctions: 1 });
  });

  it("skip empty, missing and saving drafts, and say why", () => {
    seed();
    store().setSql("t1", "new:procedure:a", "  ");
    store().syncMissing("t1", new Set());
    expect(
      collectPendingObjectSaveEntries({ tabId: "t1", engine: "postgres" })
    ).toEqual([]);
    const skipped = collectSkippedObjectDrafts({
      tabId: "t1",
      engine: "postgres",
    });
    expect(skipped.map((s) => s.reason).sort()).toEqual([
      "its SQL is empty",
      "no longer exists in the database",
    ]);
  });

  it("are read-only", () => {
    collectPendingObjectSaveEntries({ tabId: "t1", engine: "postgres" });
    expect(store().drafts).toEqual({});
  });

  it("report conflicts that this save would overwrite, and skipped work", () => {
    seed();
    const gen = store().drafts.t1![`obj:${fn.id}`]!.generation;
    store().applyDefinition("t1", `obj:${fn.id}`, gen, "CHANGED ELSEWHERE", fn);
    store().setSql("t1", "new:procedure:a", "");
    expect(
      collectObjectSaveNotices({ tabId: "t1", engine: "postgres" })
    ).toEqual([
      { kind: "conflict", key: `obj:${fn.id}`, name: "calc" },
      {
        kind: "skipped",
        key: "new:procedure:a",
        name: "p1",
        reason: "its SQL is empty",
      },
    ]);
  });
});
