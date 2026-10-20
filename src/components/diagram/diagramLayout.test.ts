import { describe, expect, it } from "vitest";
import {
  buildDiagramLayout,
  CARD_WIDTH,
  HEADER_HEIGHT,
  layoutDiagram,
  MARK_CLEARANCE,
  ROW_HEIGHT,
  routeDiagramRelations,
  tableKey,
  type DiagramLayout,
  type LayoutItem,
  type RelationGeometry,
} from "./diagramLayout";
import type { DiagramRelation, DiagramTable } from "./diagramTypes";

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTables(count: number, seed: number): DiagramTable[] {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => ({
    schema: "public",
    name: `t${i}`,
    columns: Array.from({ length: 1 + Math.floor(random() * 40) }, (_, c) => ({
      name: c === 0 ? "id" : `c${c}`,
      type: "uuid",
      isPrimaryKey: c === 0,
    })),
  }));
}

function makeSchema(tableCount: number, relationCount: number, seed: number) {
  const random = rng(seed * 7919);
  const tables = makeTables(tableCount, seed);
  const relations: DiagramRelation[] = Array.from(
    { length: relationCount },
    () => {
      const from = tables[Math.floor(random() * tables.length)]!;
      const to = tables[Math.floor(random() * tables.length)]!;
      return {
        fromTable: tableKey(from.schema, from.name),
        toTable: tableKey(to.schema, to.name),
        label: "fk",
        fromColumn: "id",
        toColumn: to.columns[Math.floor(random() * to.columns.length)]!.name,
        cardinality: random() < 0.2 ? "one-to-one" : "one-to-many",
      };
    }
  );
  return { tables, relations };
}

function relation(
  from: string,
  to: string,
  fromColumn = "id",
  toColumn = "id",
  cardinality: DiagramRelation["cardinality"] = "one-to-many"
): DiagramRelation {
  return {
    fromTable: from,
    toTable: to,
    label: "fk",
    fromColumn,
    toColumn,
    cardinality,
  };
}

type Point = { x: number; y: number };

/** True when the axis-aligned segment a–b passes through the inside of the card. */
function crossesCard(a: Point, b: Point, card: LayoutItem) {
  const inset = 0.5;
  return (
    Math.max(a.x, b.x) > card.x + inset &&
    Math.min(a.x, b.x) < card.x + card.width - inset &&
    Math.max(a.y, b.y) > card.y + inset &&
    Math.min(a.y, b.y) < card.y + card.height - inset
  );
}

/** Independent expectation of a column row's vertical middle. */
function expectedRowY(item: LayoutItem, column?: string) {
  const index = item.table.columns.findIndex(
    (c) => c.name.toLowerCase() === (column ?? "").toLowerCase()
  );
  return index < 0
    ? item.y + item.height / 2
    : item.y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** The straight lengths at both ends of an emitted (rounded) SVG path. */
function emittedEndStubs(path: string) {
  const commands = [...path.matchAll(/([MLQ])([^MLQ]*)/g)].map((m) => ({
    op: m[1]!,
    nums: m[2]!.trim().split(/\s+/).map(Number),
  }));
  const endOf = (c: { nums: number[] }) => ({
    x: c.nums[c.nums.length - 2]!,
    y: c.nums[c.nums.length - 1]!,
  });
  const start = endOf(commands[0]!);
  const second = commands[1]!;
  const last = commands[commands.length - 1]!;
  const beforeLast = endOf(commands[commands.length - 2]!);
  const end = endOf(last);
  return {
    startOp: second.op,
    start: Math.hypot(endOf(second).x - start.x, endOf(second).y - start.y),
    endOp: last.op,
    end: Math.hypot(end.x - beforeLast.x, end.y - beforeLast.y),
  };
}

function assertRoutes(
  layout: DiagramLayout,
  relations: DiagramRelation[],
  routes: Array<RelationGeometry | null>
) {
  const itemByKey = new Map(layout.items.map((item) => [item.key, item]));
  relations.forEach((rel, index) => {
    const route = routes[index];
    const from = itemByKey.get(rel.fromTable)!;
    const to = itemByKey.get(rel.toTable)!;
    expect(route, `relation ${index}`).toBeTruthy();
    const points = route!.points;
    const problems: string[] = [];

    for (const point of points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
        problems.push(`non-finite point ${point.x},${point.y}`);
      if (
        point.x < 0 ||
        point.x > layout.width ||
        point.y < 0 ||
        point.y > layout.height
      )
        problems.push(`point ${point.x},${point.y} outside the layout`);
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (a.x !== b.x && a.y !== b.y) problems.push(`segment ${i} is diagonal`);
      // Collected first: one expect per pair is slow on large diagrams.
      for (const card of layout.items)
        if (crossesCard(a, b, card))
          problems.push(`segment ${i} crosses ${card.key}`);
    }

    // Attached to the right rows, on the edges of the right cards.
    if (route!.startY !== expectedRowY(from, rel.fromColumn))
      problems.push(`starts at y ${route!.startY}`);
    const sameRowSelf =
      from === to &&
      expectedRowY(from, rel.fromColumn) === expectedRowY(to, rel.toColumn);
    const wantEndY = expectedRowY(to, rel.toColumn) + (sameRowSelf ? 12 : 0);
    if (route!.endY !== wantEndY) problems.push(`ends at y ${route!.endY}`);
    if (![from.x, from.x + from.width].includes(route!.startX))
      problems.push(`starts off the source edge at x ${route!.startX}`);
    if (route!.endX !== (route!.enterFrom === "left" ? to.x : to.x + to.width))
      problems.push(`ends off the target edge at x ${route!.endX}`);

    // The emitted path keeps a straight stub for the marks at both ends.
    const stubs = emittedEndStubs(route!.path);
    if (stubs.startOp !== "L" || stubs.start < MARK_CLEARANCE)
      problems.push(`start stub ${stubs.startOp} ${stubs.start}`);
    if (stubs.endOp !== "L" || stubs.end < MARK_CLEARANCE)
      problems.push(`end stub ${stubs.endOp} ${stubs.end}`);

    expect(
      problems,
      `relation ${index} (${rel.fromTable} → ${rel.toTable})`
    ).toEqual([]);
  });
}

/**
 * Segments of different relations never run on top of each other. The only exception is
 * fan-out: end runs of two relations attached to the very same point of a card.
 */
function assertDistinguishable(routes: Array<RelationGeometry | null>) {
  type Run = {
    owner: number;
    fixed: number;
    lo: number;
    hi: number;
    /** Card attachment points this run touches (an end run's card edge). */
    attach: string[];
  };
  const vertical: Run[] = [];
  const horizontal: Run[] = [];
  routes.forEach((route, owner) => {
    if (!route) return;
    const points = route.points;
    const last = points.length - 1;
    for (let i = 1; i <= last; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const attach: string[] = [];
      if (i === 1) attach.push(`${points[0]!.x},${points[0]!.y}`);
      if (i === last) attach.push(`${points[last]!.x},${points[last]!.y}`);
      if (a.x === b.x)
        vertical.push({
          owner,
          fixed: a.x,
          lo: Math.min(a.y, b.y),
          hi: Math.max(a.y, b.y),
          attach,
        });
      else
        horizontal.push({
          owner,
          fixed: a.y,
          lo: Math.min(a.x, b.x),
          hi: Math.max(a.x, b.x),
          attach,
        });
    }
  });
  const clashes: string[] = [];
  for (const runs of [vertical, horizontal]) {
    const byFixed = new Map<number, Run[]>();
    for (const run of runs)
      byFixed.set(run.fixed, [...(byFixed.get(run.fixed) ?? []), run]);
    for (const [fixed, group] of byFixed) {
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          if (a.owner === b.owner) continue;
          if (a.attach.some((point) => b.attach.includes(point))) continue;
          if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 0)
            clashes.push(`relations ${a.owner} and ${b.owner} share ${fixed}`);
        }
    }
  }
  expect(clashes).toEqual([]);
}

describe("crossesCard (test oracle)", () => {
  const card = { x: 100, y: 100, width: 50, height: 40 } as LayoutItem;
  it.each([
    ["a horizontal crossing", { x: 50, y: 120 }, { x: 200, y: 120 }, true],
    ["a vertical crossing", { x: 120, y: 50 }, { x: 120, y: 200 }, true],
    ["a run ending inside", { x: 50, y: 120 }, { x: 120, y: 120 }, true],
    ["a run along the top edge", { x: 50, y: 100 }, { x: 200, y: 100 }, false],
    [
      "a run touching the left edge",
      { x: 50, y: 120 },
      { x: 100, y: 120 },
      false,
    ],
    ["a run beside the card", { x: 160, y: 50 }, { x: 160, y: 200 }, false],
    ["a run above the card", { x: 50, y: 90 }, { x: 200, y: 90 }, false],
  ])("%s → %s", (_case, a, b, expected) => {
    expect(crossesCard(a, b, card)).toBe(expected);
  });
});

describe("layoutDiagram", () => {
  it.each([
    [12, 20, 1],
    [60, 120, 2],
    [150, 300, 3],
    [150, 600, 4],
  ])(
    "routes %i tables / %i relations (seed %i) around every card, on distinct lanes",
    (tableCount, relationCount, seed) => {
      const { tables, relations } = makeSchema(tableCount, relationCount, seed);
      const { layout, routes, overflow } = layoutDiagram(tables, relations);
      expect(overflow).toBe(false);
      assertRoutes(layout, relations, routes);
      assertDistinguishable(routes);
    }
  );

  it("widens the gutter when many overlapping relations need their own lanes", () => {
    // Two tables, two columns: every relation crosses the one gutter, and the swapped
    // rows make all their vertical runs overlap.
    const columns = Array.from({ length: 40 }, (_, c) => ({
      name: `c${c}`,
      type: "uuid",
    }));
    const tables: DiagramTable[] = [
      { schema: "public", name: "a", columns },
      { schema: "public", name: "b", columns },
    ];
    const relations = Array.from({ length: 30 }, (_, i) =>
      relation("public.a", "public.b", `c${i}`, `c${39 - i}`)
    );

    const before = buildDiagramLayout(tables, relations);
    const { layout, routes, overflow } = layoutDiagram(tables, relations);

    expect(overflow).toBe(false);
    expect(layout.items[1]!.x - layout.items[0]!.x).toBeGreaterThan(
      before.items[1]!.x - before.items[0]!.x
    );
    assertRoutes(layout, relations, routes);
    // Swapped rows cannot all share one lane per relation without opposite end runs
    // overlapping; relations step between lanes instead, and none ever coincide.
    assertDistinguishable(routes);
  });

  it("widens the right margin for many self-references of a one-table diagram", () => {
    const tables = makeTables(1, 14);
    tables[0]!.columns = Array.from({ length: 30 }, (_, c) => ({
      name: `c${c}`,
      type: "uuid",
    }));
    const key = tableKey("public", tables[0]!.name);
    const relations = Array.from({ length: 12 }, (_, i) =>
      relation(key, key, `c${i}`, `c${29 - i}`)
    );

    const { layout, routes, overflow } = layoutDiagram(tables, relations);

    expect(overflow).toBe(false);
    assertRoutes(layout, relations, routes);
    assertDistinguishable(routes);
  });

  it("gives every relation crossing one column its own row, even toward a gap edge", () => {
    const tables = makeTables(18, 6);
    const base = buildDiagramLayout(tables, []);
    const left = base.items.filter((item) => item.column === 0);
    const right = base.items.filter((item) => item.column === 2);
    const relations = Array.from({ length: 24 }, (_, i) =>
      relation(left[i % left.length]!.key, right[i % right.length]!.key)
    );

    const { layout, routes, overflow } = layoutDiagram(tables, relations);

    expect(overflow).toBe(false);
    assertRoutes(layout, relations, routes);
    assertDistinguishable(routes);
  });

  it("keeps opposite end runs on one row apart (a.c0→c, b.c0→d across one gutter)", () => {
    const columns = Array.from({ length: 5 }, (_, c) => ({
      name: `c${c}`,
      type: "uuid",
    }));
    const tables: DiagramTable[] = ["a", "b", "c", "d"].map((name) => ({
      schema: "public",
      name,
      columns,
    }));
    const relations = [
      ...[1, 2, 3, 4].map((i) =>
        relation("public.a", "public.c", "c0", `c${i}`)
      ),
      ...[1, 2, 3, 4].map((i) =>
        relation("public.b", "public.d", "c0", `c${i}`)
      ),
    ];

    const { layout, routes, overflow } = layoutDiagram(tables, relations);

    expect(overflow).toBe(false);
    assertRoutes(layout, relations, routes);
    assertDistinguishable(routes);
  });

  it("loops a same-column relation through the inner gutter, also in the last column", () => {
    const tables = makeTables(12, 7);
    const base = buildDiagramLayout(tables, []);
    const last = Math.max(...base.items.map((item) => item.column));
    const pick = (column: number) =>
      base.items.filter((item) => item.column === column);
    const relations = [
      relation(pick(0)[0]!.key, pick(0)[1]!.key),
      relation(pick(last)[0]!.key, pick(last)[1]!.key),
    ];

    const { layout, routes } = layoutDiagram(tables, relations);
    const itemByKey = new Map(layout.items.map((item) => [item.key, item]));

    expect(routes[0]!.enterFrom).toBe("right");
    expect(routes[0]!.startX).toBe(
      itemByKey.get(relations[0]!.fromTable)!.x + CARD_WIDTH
    );
    expect(routes[1]!.enterFrom).toBe("left");
    expect(routes[1]!.fromRight).toBe(false);
    expect(routes[1]!.startX).toBe(itemByKey.get(relations[1]!.fromTable)!.x);
    assertRoutes(layout, relations, routes);
  });

  it("loops a self-reference on one row out and back with room for its marks", () => {
    const tables = makeTables(1, 8);
    const key = tableKey("public", tables[0]!.name);
    const relations = [relation(key, key, "id", "id", "one-to-one")];

    const { layout, routes } = layoutDiagram(tables, relations);

    expect(routes[0]!.endY).not.toBe(routes[0]!.startY);
    assertRoutes(layout, relations, routes);
  });

  it("handles an empty diagram and relations to missing tables", () => {
    expect(layoutDiagram([], [])).toMatchObject({
      routes: [],
      overflow: false,
      layout: { items: [], width: 640, height: 400 },
    });
    const tables = makeTables(3, 9);
    const relations = [relation("public.missing", tableKey("public", "t0"))];
    expect(layoutDiagram(tables, relations).routes).toEqual([null]);
  });

  it("is deterministic", () => {
    const { tables, relations } = makeSchema(40, 80, 11);
    expect(layoutDiagram(tables, relations)).toEqual(
      layoutDiagram(tables, relations)
    );
  });
});

describe("routeDiagramRelations without widening", () => {
  it("reports overflow when a fixed layout lacks lanes", () => {
    const tables = makeTables(12, 12);
    const layout = buildDiagramLayout(tables, []);
    const column = layout.items.filter((item) => item.column === 0);
    const relations = Array.from({ length: 30 }, () =>
      relation(column[0]!.key, column[1]!.key)
    );

    const routed = routeDiagramRelations(layout, relations);

    expect(routed.overflow).toBe(true);
    expect(routed.demand.gutterLanes).toBe(30);
    // Still never through a card while lanes are shared.
    assertRoutes(layout, relations, routed.routes);
  });

  it("would flag the previous straight route across a middle column", () => {
    const layout = buildDiagramLayout(makeTables(18, 13), []);
    const left = layout.items.find((item) => item.column === 0)!;
    const middle = layout.items.find((item) => item.column === 1)!;
    const right = layout.items.find((item) => item.column === 2)!;
    const y = middle.y + middle.height / 2;
    expect(
      crossesCard(
        { x: left.x + CARD_WIDTH + 26, y },
        { x: right.x - 26, y },
        middle
      )
    ).toBe(true);
  });
});
