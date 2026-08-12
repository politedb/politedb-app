import { describe, expect, it } from "vitest";
import {
  buildAssistantContext,
  formatMissingDatabaseContextReply,
  getAssistantScopeInstruction,
  hasConcreteDatabaseContext,
  isDatabaseSpecificRequest,
  selectRelevantSchema,
} from "./context";

describe("assistant context", () => {
  it("treats no active connection as global context", () => {
    const context = buildAssistantContext({
      engine: "postgres",
      tables: [],
    });

    expect(context.scope).toBe("global");
    expect(hasConcreteDatabaseContext(context)).toBe(false);
    expect(getAssistantScopeInstruction(context)).toContain(
      "No active database schema"
    );
  });

  it("treats an active connection as database context even before table metadata loads", () => {
    const context = buildAssistantContext({
      engine: "postgres",
      runtimeConnectionId: "conn_1",
      tables: [],
    });

    expect(context.scope).toBe("connection");
    expect(hasConcreteDatabaseContext(context)).toBe(true);
  });

  it("detects database-specific requests but allows generic SQL examples", () => {
    expect(isDatabaseSpecificRequest("lấy tất cả users")).toBe(true);
    expect(isDatabaseSpecificRequest("write a generic SQL example")).toBe(
      false
    );
  });

  it("keeps schema context focused on relevant tables", () => {
    const selected = selectRelevantSchema({
      question: "show latest users by email",
      activeSchema: "public",
      tables: [
        { schema: "public", name: "orders" },
        { schema: "public", name: "users" },
        { schema: "private", name: "users" },
      ],
      columnsByTable: {
        "public.orders": ["id", "total"],
        "public.users": ["id", "email", "created_at"],
        "private.users": ["id", "secret"],
      },
    });

    expect(
      selected.tables.map((table) => `${table.schema}.${table.name}`)
    ).toEqual(["public.users", "public.orders"]);
    expect(selected.columnsByTable["public.users"]).toEqual([
      "id",
      "email",
      "created_at",
    ]);
    expect(selected.columnsByTable["private.users"]).toBeUndefined();
  });

  it("keeps a table mentioned in recent conversation ahead of schema truncation", () => {
    const tables = Array.from({ length: 30 }, (_, index) => ({
      schema: "public",
      name: `table_${String(index).padStart(2, "0")}`,
    }));
    tables.push({ schema: "public", name: "hosts" });

    const selected = selectRelevantSchema({
      question: "show data from hosts\ný là metadata",
      activeSchema: "public",
      tables,
      maxTables: 12,
    });

    expect(selected.tables[0]).toEqual({ schema: "public", name: "hosts" });
    expect(selected.tables).toHaveLength(12);
  });

  it("prefers an explicitly named table over a stale active table", () => {
    const selected = selectRelevantSchema({
      question: "show structure and columns for hosts",
      activeSchema: "fleet",
      activeTable: { schema: "fleet", name: "activities" },
      tables: [
        { schema: "fleet", name: "activities" },
        { schema: "fleet", name: "hosts" },
      ],
      columnsByTable: {
        "fleet.activities": ["id", "name"],
        "fleet.hosts": ["id", "hostname"],
      },
    });

    expect(selected.tables[0]).toEqual({ schema: "fleet", name: "hosts" });
  });

  it("keeps rich column metadata for selected tables", () => {
    const selected = selectRelevantSchema({
      question: "describe users email",
      activeSchema: "public",
      tables: [{ schema: "public", name: "users" }],
      columnsByTable: { "public.users": ["id", "email"] },
      columnDetailsByTable: {
        "public.users": [
          { name: "id", dataType: "bigint", nullable: "NO" },
          {
            name: "email",
            dataType: "varchar",
            nullable: "NO",
            defaultValue: "''",
          },
        ],
      },
    });

    expect(selected.columnDetailsByTable["public.users"]?.[1]).toEqual({
      name: "email",
      dataType: "varchar",
      nullable: "NO",
      defaultValue: "''",
    });
  });

  it("formats missing-context replies in Vietnamese", () => {
    expect(
      formatMissingDatabaseContextReply({
        question: "lấy users",
        replyLanguageCode: "vie",
      })
    ).toContain("chưa có connection/schema active");
  });
});
