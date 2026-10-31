import { describe, expect, it } from "vitest";
import { mergeSidebarTables, unresolvedNewTableDrafts } from "./newTableDrafts";
import type { TableItem } from "src/types";

const draft = (tableName: string, identity?: object) => ({
  tableName,
  primaryKey: "id",
  columns: [],
  ...identity,
});

const merge = (drafts: Record<string, object>, tables: TableItem[] = []) =>
  mergeSidebarTables({
    tables,
    windows: [],
    drafts,
    activeSchema: "public",
    search: "",
  });

describe("the sidebar's closed new-table drafts", () => {
  it("lists a resolved draft once, deduplicated against the schema's tables", () => {
    const drafts = {
      "table:public.untitled": draft("orders", {
        schema: "public",
        windowName: "untitled",
      }),
    };
    expect(merge(drafts).map((t) => t.draftWindowId)).toEqual([
      "table:public.untitled",
    ]);
    expect(
      merge(drafts, [{ schema: "public", name: "orders" }]).map((t) => t.name)
    ).toEqual(["orders"]);
  });

  it("always lists an unresolved draft on its own: next to a table of its name, another such draft, or with a blank name", () => {
    const items = merge(
      {
        "table:tenant.eu.a": draft("orders"),
        "table:tenant.eu.b": draft("orders"),
        "table:tenant.eu.c": draft("  "),
      },
      [{ schema: "public", name: "orders" }]
    );
    const unresolved = items.filter((t) => t.unresolvedDraft);
    expect(unresolved.map((t) => t.draftWindowId)).toEqual([
      "table:tenant.eu.a",
      "table:tenant.eu.b",
      "table:tenant.eu.c",
    ]);
    expect(unresolved.map((t) => t.name)).toEqual([
      "orders (cannot be saved)",
      "orders (cannot be saved)",
      "untitled (cannot be saved)",
    ]);
    // The real table stays its own item.
    expect(items.filter((t) => !t.new).map((t) => t.name)).toEqual(["orders"]);
  });

  it("reports the same unresolved drafts the sidebar lists", () => {
    const drafts = {
      "table:tenant.eu.a": draft("orders"),
      "table:public.ok": draft("fine"),
    };
    expect(unresolvedNewTableDrafts(drafts, [])).toEqual([
      { windowId: "table:tenant.eu.a", name: "orders" },
    ]);
    // An open window gives it an identity: not unresolved.
    expect(
      unresolvedNewTableDrafts(drafts, [{ id: "table:tenant.eu.a" }])
    ).toEqual([]);
  });
});
