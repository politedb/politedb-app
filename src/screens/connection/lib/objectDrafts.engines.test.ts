import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import {
  collectObjectSaveNotices,
  collectPendingObjectSaveEntries,
} from "src/lib/objectEditorDraftCache";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import { useToastStore } from "src/stores/toast";
import type { DatabaseEngine, DatabaseObjectKind } from "src/types";
import { saveObjectDraftsForTab } from "./objectSave";
import {
  metaKeyForTab,
  newObjectDraftInit,
  openCreatedObject,
} from "./objectWindows";

/**
 * The draft lifecycle on the other engines with object editors: MySQL and
 * MariaDB (functions, procedures, triggers), SQLite and Turso (triggers).
 */

const mocks = vi.hoisted(() => ({
  runSqlQuery: vi.fn(),
  executeTransaction: vi.fn(),
}));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: mocks.runSqlQuery }));
vi.mock("src/lib/tauri", () => ({
  operationExecuteTransaction: mocks.executeTransaction,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const TAB = "t1";
const drafts = () => useObjectDraftStore.getState();

function item(
  engine: DatabaseEngine,
  kind: DatabaseObjectKind,
  name: string,
  extra: { schema?: string; tableName?: string } = {}
) {
  return buildDatabaseObjectItem({
    engine,
    kind,
    schema:
      extra.schema ??
      (engine === "sqlite" || engine === "turso" ? "main" : "app"),
    name,
    signature: "",
    tableName: extra.tableName,
  });
}

function seedDirtyEdit(
  object: ReturnType<typeof item>,
  sql: string,
  baseline = "original definition"
) {
  const key = `obj:${object.id}`;
  drafts().ensureEditDraft(TAB, key, object);
  drafts().applyDefinition(
    TAB,
    key,
    drafts().drafts[TAB]![key]!.generation,
    baseline,
    object
  );
  drafts().setSql(TAB, key, sql);
  return key;
}

function seedCreate(
  engine: DatabaseEngine,
  kind: DatabaseObjectKind,
  key = `new:${kind}:a`
) {
  const init = newObjectDraftInit({
    tabId: TAB,
    engine,
    kind,
    schema: engine === "sqlite" || engine === "turso" ? "main" : "app",
    tables: [
      {
        schema: engine === "sqlite" || engine === "turso" ? "main" : "app",
        name: "orders",
      },
    ],
    existingNames: [],
  });
  drafts().ensureCreateDraft(TAB, key, init);
  return { key, init };
}

function save(engine: DatabaseEngine) {
  return saveObjectDraftsForTab({
    tabId: TAB,
    engine,
    resolveConnectionId: async () => "c1",
    refreshFallback: vi.fn(async () => {}),
    setError: vi.fn(),
  });
}

beforeEach(() => {
  mocks.runSqlQuery.mockReset().mockResolvedValue({});
  mocks.executeTransaction.mockReset().mockResolvedValue({});
  drafts().clearAll();
  useToastStore.setState({ toasts: [] });
  useScreenStore.setState({
    openWindows: { [TAB]: [] },
    activeWindowId: { [TAB]: null },
    profileTabs: [
      { id: TAB, engine: "mysql", runtimeConnectionId: "c1" } as never,
    ],
    tabEpoch: {},
  });
});

describe.each(["mysql", "mariadb"] as const)("%s object drafts", (engine) => {
  it.each(["function", "procedure", "trigger"] as const)(
    "a closed new %s runs once from its template and is consumed",
    async (kind) => {
      const { key, init } = seedCreate(engine, kind);
      if (kind === "trigger") expect(init.form.tableName).toBe("orders");
      expect(init.sql).toMatch(/CREATE/i);

      await save(engine);
      expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);
      expect(mocks.runSqlQuery.mock.calls[0]![1]).toBe(init.sql.trim());
      expect(drafts().drafts[TAB]?.[key]).toBeUndefined();

      await save(engine);
      expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);
    }
  );

  it("an edited procedure body is replaced with DROP + CREATE in one transaction", async () => {
    const proc = item(engine, "procedure", "recalc");
    const key = seedDirtyEdit(proc, "BEGIN SELECT 2; END");
    await save(engine);
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();
    const statements = mocks.executeTransaction.mock.calls[0]![0].statements;
    expect(statements).toEqual([
      `DROP PROCEDURE IF EXISTS \`app\`.\`recalc\`;`,
      "BEGIN SELECT 2; END",
    ]);
    expect(drafts().drafts[TAB]![key]!.baselineSql).toBe("BEGIN SELECT 2; END");
  });

  it("an edited trigger drops and recreates it; a failure keeps the draft", async () => {
    const trigger = item(engine, "trigger", "orders_audit", {
      tableName: "orders",
    });
    const key = seedDirtyEdit(trigger, "CREATE TRIGGER orders_audit ...");
    mocks.executeTransaction.mockRejectedValueOnce(new Error("denied"));
    await expect(save(engine)).rejects.toThrow("denied");
    expect(mocks.executeTransaction.mock.calls[0]![0].statements[0]).toBe(
      "DROP TRIGGER IF EXISTS `app`.`orders_audit`;"
    );
    expect(drafts().drafts[TAB]![key]!.sql).toBe(
      "CREATE TRIGGER orders_audit ..."
    );
    expect(drafts().drafts[TAB]![key]!.baselineSql).toBe("original definition");
  });

  it("keeps same-name objects of different schemas and kinds apart", () => {
    seedDirtyEdit(item(engine, "function", "calc", { schema: "a" }), "x");
    seedDirtyEdit(item(engine, "function", "calc", { schema: "b" }), "y");
    seedDirtyEdit(item(engine, "procedure", "calc", { schema: "a" }), "z");
    expect(
      collectPendingObjectSaveEntries({ tabId: TAB, engine })
    ).toHaveLength(3);
  });
});

describe.each(["sqlite", "turso"] as const)("%s object drafts", (engine) => {
  it("a closed new trigger runs once on its table and is consumed", async () => {
    const { key, init } = seedCreate(engine, "trigger");
    expect(init.form.tableName).toBe("orders");
    expect(init.sql).toMatch(/CREATE TRIGGER/i);
    await save(engine);
    expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);
    expect(drafts().drafts[TAB]?.[key]).toBeUndefined();
  });

  it("an edited trigger is dropped by name and recreated in one transaction", async () => {
    const trigger = item(engine, "trigger", "orders_audit", {
      tableName: "orders",
    });
    seedDirtyEdit(trigger, "CREATE TRIGGER orders_audit AFTER INSERT ...");
    await save(engine);
    expect(mocks.executeTransaction.mock.calls[0]![0].statements).toEqual([
      'DROP TRIGGER IF EXISTS "orders_audit";',
      "CREATE TRIGGER orders_audit AFTER INSERT ...",
    ]);
  });

  it("never runs functions or procedures, and the review says why", async () => {
    seedCreate(engine, "function", "new:function:a");
    seedCreate(engine, "procedure", "new:procedure:a");
    expect(collectPendingObjectSaveEntries({ tabId: TAB, engine })).toEqual([]);
    expect(
      collectObjectSaveNotices({ tabId: TAB, engine }).map((n) =>
        n.kind === "skipped" ? n.reason : n.kind
      )
    ).toEqual([
      "this database cannot save it here",
      "this database cannot save it here",
    ]);
    await save(engine);
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();
    expect(mocks.executeTransaction).not.toHaveBeenCalled();
  });

  it("Open finds the created trigger by kind, schema and name", async () => {
    const tab = { id: TAB, engine, runtimeConnectionId: "c1" };
    useScreenStore.setState({ profileTabs: [tab as never] });
    const created = item(engine, "trigger", "orders_audit", {
      tableName: "orders",
    });
    await openCreatedObject({
      screenTabId: TAB,
      connectionId: "c1",
      kind: "trigger",
      schema: "main",
      name: "orders_audit",
      refresh: async () => ({
        ok: true,
        metaKey: metaKeyForTab(tab),
        connectionId: "c1",
        objects: [created, item(engine, "trigger", "other")],
      }),
    });
    expect(useScreenStore.getState().openWindows[TAB]).toHaveLength(1);
  });
});
