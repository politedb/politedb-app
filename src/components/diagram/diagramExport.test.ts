import { describe, expect, it } from "vitest";
import { buildDiagramSvg } from "./diagramExport";
import type { DiagramState } from "./diagramTypes";

function diagram(cardinality: "one-to-one" | "one-to-many"): DiagramState {
  return {
    mermaid: "",
    tableCount: 2,
    relationshipCount: 1,
    tables: [
      {
        schema: "public",
        name: "users<&",
        columns: [{ name: "id", type: "uuid", isPrimaryKey: true }],
      },
      {
        schema: "public",
        name: "orders",
        columns: [{ name: "user_id", type: "uuid" }],
      },
    ],
    relations: [
      {
        fromTable: "public.users<&",
        toTable: "public.orders",
        label: "user_id",
        fromColumn: "id",
        toColumn: "user_id",
        cardinality,
      },
    ],
  };
}

describe("buildDiagramSvg", () => {
  it("escapes labels and renders one-to-many markers", () => {
    const svg = buildDiagramSvg(diagram("one-to-many"));

    expect(svg).toContain("users&lt;&amp;");
    expect(svg).toContain('<g id="rel-0">');
    expect(svg).toContain('stroke="#d97706"');
    expect(svg.match(/<circle cx=/g)).toHaveLength(1);
  });

  it("renders circles for one-to-one relations", () => {
    expect(
      buildDiagramSvg(diagram("one-to-one")).match(/<circle cx=/g)
    ).toHaveLength(3);
  });
});
