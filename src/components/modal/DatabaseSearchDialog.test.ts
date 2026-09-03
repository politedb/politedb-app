import { describe, expect, it } from "vitest";
import type { TableItem } from "src/types";
import { getDatabaseSearchResults } from "./DatabaseSearchDialog";

function tables(count: number): TableItem[] {
  return Array.from({ length: count }, (_, index) => ({
    schema: "public",
    name: `table_${String(index).padStart(3, "0")}`,
  }));
}

describe("getDatabaseSearchResults", () => {
  it("returns every schema and table when query is empty", () => {
    const results = getDatabaseSearchResults(tables(112), ["public"], "");

    expect(results).toHaveLength(113);
    expect(results[results.length - 1]).toMatchObject({
      type: "table",
      data: { name: "table_111" },
    });
  });

  it("does not cap matching table results", () => {
    const results = getDatabaseSearchResults(tables(112), [], "table_");

    expect(results).toHaveLength(112);
  });
});
