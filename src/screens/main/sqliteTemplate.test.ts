import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
// Each seed statement goes through the real operation wrapper, so it meets
// the registered dispatch guard before the (spied) native call.
vi.mock("src/lib/tauri/query", async () => {
  const { operationExecute } = await import("src/lib/tauri/operation");
  return {
    runSqlQuery: (connectionId: string, sql: string) =>
      operationExecute({
        connection_id: connectionId,
        kind: "sql_query",
        sql: { sql, batch_size: 10, max_rows: 10 },
      } as never),
  };
});

// Registers the dispatch guard, as the app does.
import "src/lib/runtimeConnection";
import { openSqliteTemplateTab } from "./sqliteTemplate";
import { seedSqliteTemplateDemo } from "src/lib/sqliteTemplateSeed";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { useScreenStore } from "src/stores/screen";
import { resetTabRuntimes } from "src/test/fixtures/tabRuntime";

const saved = {
  profile: {
    id: "p-template",
    label: "Hello World",
    engine: "sqlite",
    input: { engine: "sqlite", tags: ["local"], sqlite: { path: ":memory:" } },
  },
  connection: {
    id: "rt-template",
    engine: "sqlite",
    label: "Hello World",
    target: {
      profile_id: "p-template",
      profile_revision: "r1",
      database_override: null,
      engine: "sqlite",
      display: ":memory:",
    },
  },
} as never;

const sentSql = () =>
  m.invoke.mock.calls
    .filter(([cmd]) => cmd === "operation_execute")
    .map(
      ([, args]) => (args as { input: { sql: { sql: string } } }).input.sql.sql
    );

beforeEach(() => {
  vi.clearAllMocks();
  m.invoke.mockResolvedValue("op");
  resetTabRuntimes();
});

describe("the SQLite template (D3)", () => {
  it("seeds through the guard on the tab that owns the connection", async () => {
    const tab = await openSqliteTemplateTab(saved);
    const statements = sentSql();
    expect(statements).toHaveLength(5);
    expect(statements[1]).toContain("CREATE TABLE IF NOT EXISTS demo_users");
    expect(statements[4]).toContain("INSERT INTO demo_posts");
    expect(useRuntimeTargetsStore.getState().owners["rt-template"]).toBe(
      tab.id
    );
    expect(
      useScreenStore.getState().profileTabs.find((t) => t.id === tab.id)
        ?.runtimeConnectionId
    ).toBe("rt-template");
  });

  it("still refuses SQL on a connection no tab owns", async () => {
    await expect(seedSqliteTemplateDemo("rt-unowned")).rejects.toThrow(
      "could not be confirmed"
    );
    expect(m.invoke).not.toHaveBeenCalled();
  });
});
