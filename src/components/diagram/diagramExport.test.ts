import { describe, expect, it } from "vitest";
import { buildDiagramSvg } from "./diagramExport";
import { buildDiagramLayout, layoutDiagram } from "./diagramLayout";
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

  it("draws relations before the table cards, so cards cover nothing", () => {
    const svg = buildDiagramSvg(diagram("one-to-many"));

    const firstRelation = svg.indexOf('<g id="rel-');
    const firstCard = svg.indexOf('<g transform="translate(');
    expect(firstRelation).toBeGreaterThan(-1);
    expect(firstCard).toBeGreaterThan(firstRelation);
  });

  it("uses the canvas layout, so the export matches what is on screen", () => {
    const state = diagram("one-to-many");
    const layout = buildDiagramLayout(state.tables, state.relations);
    const svg = buildDiagramSvg(state);

    expect(svg).toContain(`viewBox="0 0 ${layout.width} ${layout.height}"`);
    for (const item of layout.items) {
      expect(svg).toContain(`<g transform="translate(${item.x}, ${item.y})">`);
    }
  });

  it("places a one-to-one end circle outside the card it enters", () => {
    const state = diagram("one-to-one");
    const layout = buildDiagramLayout(state.tables, state.relations);
    const target = layout.items.find((item) => item.key === "public.orders")!;
    const svg = buildDiagramSvg(state);
    const circles = [...svg.matchAll(/<circle cx="([\d.-]+)"/g)].map((m) =>
      Number(m[1])
    );
    const end = circles[circles.length - 1]!;

    // Outside the target card, not inside it.
    expect(end < target.x || end > target.x + target.width).toBe(true);
  });

  // Degrees fix the column order (higher degree first, columns filled round-robin), so
  // the related pair lands in one column of the final layout:
  // - 3 tables X(3) Y(2) Z(1) → X and Z in the first column;
  // - 4 tables A(4) B(3) C(2) D(1) → B and D in the last column.
  it.each([
    [
      "the first column (right gutter)",
      ["x", "z"],
      [
        ["x", "y"],
        ["x", "y"],
      ],
      "right",
    ],
    [
      "the last column (left gutter)",
      ["b", "d"],
      [
        ["a", "c"],
        ["a", "c"],
        ["a", "b"],
        ["a", "b"],
      ],
      "left",
    ],
  ] as const)(
    "places one-to-one circles outside both cards for a relation within %s",
    (_where, [from, to], fillers, side) => {
      const names = [...new Set([from, to, ...fillers.flat()])];
      const tables = names.map((name) => ({
        schema: "public",
        name,
        columns: [
          { name: "id", type: "uuid", isPrimaryKey: true },
          { name: "ref", type: "uuid" },
        ],
      }));
      const link = (
        a: string,
        b: string,
        cardinality: "one-to-one" | "one-to-many"
      ) => ({
        fromTable: `public.${a}`,
        toTable: `public.${b}`,
        label: "ref",
        fromColumn: "id",
        toColumn: "ref",
        cardinality,
      });
      const relations = [
        link(from, to, "one-to-one"),
        ...fillers.map(([a, b]) => link(a, b, "one-to-many")),
      ];
      const state: DiagramState = {
        mermaid: "",
        tableCount: tables.length,
        relationshipCount: relations.length,
        tables,
        relations,
      };
      const { layout, routes } = layoutDiagram(state.tables, state.relations);
      const column = (name: string) =>
        layout.items.find((item) => item.key === `public.${name}`)!.column;
      expect(column(from)).toBe(column(to));
      const route = routes[0]!;
      expect(route.enterFrom).toBe(side);
      expect(route.fromRight).toBe(side === "right");
      const outward = side === "right" ? 9 : -9;

      const svg = buildDiagramSvg(state);

      expect(svg).toContain(
        `<circle cx="${route.startX + outward}" cy="${route.startY}"`
      );
      expect(svg).toContain(
        `<circle cx="${route.endX + outward}" cy="${route.endY}"`
      );
    }
  );
});
