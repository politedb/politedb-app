import { describe, expect, it } from "vitest";
import {
  buildCreateDatabaseObjectTemplate,
  buildDropDatabaseObjectSql,
  buildSaveStatements,
  getDatabaseObjectCapability,
  parseDatabaseObjectsFromRows,
} from "./databaseObjects";

describe("databaseObjects", () => {
  it("resolves capability matrix for supported and unsupported kinds", () => {
    expect(getDatabaseObjectCapability("postgres", "function")).toMatchObject({
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    });

    expect(getDatabaseObjectCapability("sqlite", "function")).toMatchObject({
      canList: false,
      canReadDefinition: false,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
  });

  it("parses routines and triggers into unified object items", () => {
    const objects = parseDatabaseObjectsFromRows({
      engine: "postgres",
      rows: [
        ["public", "refresh_stats", "procedure", "", "", ""],
        ["public", "calculate_total", "function", "id integer", "", ""],
        ["public", "orders_insert_audit", "trigger", "", "orders", "true"],
      ],
    });

    expect(objects).toHaveLength(3);
    expect(objects[0]).toMatchObject({
      kind: "procedure",
      schema: "public",
      name: "refresh_stats",
    });
    expect(objects[1]).toMatchObject({
      kind: "function",
      signature: "id integer",
    });
    expect(objects[2]).toMatchObject({
      kind: "trigger",
      tableName: "orders",
      enabled: true,
    });
  });

  it("builds create templates and drop sql", () => {
    expect(
      buildCreateDatabaseObjectTemplate({
        engine: "postgres",
        kind: "function",
        schema: "public",
        name: "demo_fn",
      })
    ).toContain("CREATE OR REPLACE FUNCTION");

    expect(
      buildCreateDatabaseObjectTemplate({
        engine: "sqlite",
        kind: "trigger",
        schema: "main",
        name: "demo_trigger",
        tableName: "orders",
      })
    ).toContain("CREATE TRIGGER");

    expect(
      buildDropDatabaseObjectSql({
        engine: "postgres",
        item: {
          id: "x",
          kind: "trigger",
          schema: "public",
          name: "orders_audit",
          tableName: "orders",
          engine: "postgres",
          capability: getDatabaseObjectCapability("postgres", "trigger"),
        },
      })
    ).toContain("DROP TRIGGER IF EXISTS");
  });

  it("wraps trigger edits as drop and recreate", () => {
    const statements = buildSaveStatements({
      engine: "postgres",
      item: {
        id: "x",
        kind: "trigger",
        schema: "public",
        name: "orders_audit",
        tableName: "orders",
        engine: "postgres",
        capability: getDatabaseObjectCapability("postgres", "trigger"),
      },
      sql: "CREATE TRIGGER orders_audit AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.handle_orders();",
    });

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DROP TRIGGER IF EXISTS");
    expect(statements[1]).toContain("CREATE TRIGGER orders_audit");
  });
});
