import { describe, expect, it } from "vitest";
import type { DatabaseObjectItem, TableItem } from "src/types";
import type { SavedSnippet } from "src/lib/snippets/types";
import { getDatabaseSearchResults } from "./DatabaseSearchDialog";

function tables(count: number): TableItem[] {
  return Array.from({ length: count }, (_, index) => ({
    schema: "public",
    name: `table_${String(index).padStart(3, "0")}`,
  }));
}

function objects(): DatabaseObjectItem[] {
  return [
    {
      id: "function:public:fn_a::",
      kind: "function",
      schema: "public",
      name: "fn_a",
      signature: "",
      engine: "postgres",
      capability: {
        canList: true,
        canReadDefinition: true,
        canCreate: true,
        canEdit: true,
        canDelete: true,
      },
    },
    {
      id: "trigger:public:trg_b::",
      kind: "trigger",
      schema: "public",
      name: "trg_b",
      engine: "postgres",
      capability: {
        canList: true,
        canReadDefinition: true,
        canCreate: true,
        canEdit: true,
        canDelete: true,
      },
    },
  ];
}

function snippets(): SavedSnippet[] {
  return [
    {
      id: "snip-1",
      name: "List users",
      sql: "select * from users",
      folderId: null,
      scope: "global",
      profileId: null,
      hotkey: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      sortOrder: 0,
    },
  ];
}

describe("getDatabaseSearchResults", () => {
  it("returns every schema and table when query is empty", () => {
    const results = getDatabaseSearchResults({
      tables: tables(112),
      schemas: ["public"],
      query: "",
    });

    expect(results).toHaveLength(113);
    expect(results[results.length - 1]).toMatchObject({
      type: "table",
      data: { name: "table_111" },
    });
  });

  it("does not cap matching table results", () => {
    const results = getDatabaseSearchResults({
      tables: tables(112),
      schemas: [],
      query: "table_",
    });

    expect(results).toHaveLength(112);
  });

  it("includes matching objects and snippets", () => {
    const results = getDatabaseSearchResults({
      tables: [],
      schemas: [],
      objects: objects(),
      snippets: snippets(),
      query: "fn",
    });

    expect(results).toEqual([
      expect.objectContaining({
        type: "object",
        data: expect.objectContaining({ name: "fn_a", kind: "function" }),
      }),
    ]);

    const bySnippet = getDatabaseSearchResults({
      tables: [],
      schemas: [],
      objects: objects(),
      snippets: snippets(),
      query: "users",
    });
    expect(bySnippet.some((r) => r.type === "snippet")).toBe(true);
    expect(
      bySnippet.some((r) => r.type === "object" && r.data.kind === "trigger")
    ).toBe(false);
  });
});
