import type { DiagramRelation, DiagramTable } from "./diagramTypes";

/**
 * Layout and relation routing shared by the diagram canvas and its SVG export, so an
 * export shows exactly what the canvas shows.
 *
 * Tables sit in columns. Relations are orthogonal paths that only run through free
 * space: vertical runs stay in the gutters between columns, and a relation that crosses
 * a column does so through a gap between two tables. No segment enters a table card
 * except where it attaches to its own table's edge.
 */

export type LayoutItem = {
  key: string;
  table: DiagramTable;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
};

export type DiagramLayout = {
  items: LayoutItem[];
  width: number;
  height: number;
};

export type DiagramRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RelationGeometry = {
  path: string;
  points: Array<{ x: number; y: number }>;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Side of the target card the relation enters. */
  enterFrom: "left" | "right";
  /** Whether the relation leaves its source card on the right. */
  fromRight: boolean;
  segments: DiagramRect[];
};

export const CARD_WIDTH = 280;
export const HEADER_HEIGHT = 42;
export const ROW_HEIGHT = 28;
export const DIAGRAM_PAD = 32;
export const EMPTY_DIAGRAM_WIDTH = 640;
export const EMPTY_DIAGRAM_HEIGHT = 400;
export const COLUMN_H_GAP = 56;
export const ROW_GAP = 48;
export const REL_CORNER_RADIUS = 10;

/** Spacing of a layout; the router widens it when relations need more lanes. */
export type DiagramSpacing = {
  /** Gutter between two columns. */
  columnGap: number;
  /** Gap between two cards of one column. */
  rowGap: number;
  /** Margin right of the last column. */
  rightMargin: number;
};

export const DEFAULT_DIAGRAM_SPACING: DiagramSpacing = {
  columnGap: COLUMN_H_GAP,
  rowGap: ROW_GAP,
  rightMargin: DIAGRAM_PAD,
};

/** Room kept free next to a card edge for the cardinality marks. */
const GUTTER_EDGE_MARGIN = 14;
/** Distance between parallel vertical runs in one gutter. */
const GUTTER_LANE_SPACING = 6;
/** Room kept free above and below a card when a relation crosses its column. */
const GAP_CARD_MARGIN = 10;
/** Distance between parallel horizontal runs through one gap. */
const GAP_LANE_SPACING = 5;
/** Offset of a self-relation's return when it starts and ends on the same row. */
const SELF_LOOP_DROP = 12;

export function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

export function estimateCardHeight(columnCount: number) {
  return HEADER_HEIGHT + Math.max(1, columnCount) * ROW_HEIGHT + 16;
}

function chooseColumnCount(tableCount: number): number {
  if (tableCount <= 1) return 1;
  return Math.min(12, Math.max(2, Math.ceil(tableCount / 6)));
}

function columnXPositions(numColumns: number, columnGap: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < numColumns; i++)
    xs.push(DIAGRAM_PAD + i * (CARD_WIDTH + columnGap));
  return xs;
}

function normalizeLayoutBounds(
  items: LayoutItem[],
  rightMargin: number
): DiagramLayout {
  if (items.length === 0)
    return { items, width: EMPTY_DIAGRAM_WIDTH, height: EMPTY_DIAGRAM_HEIGHT };
  const minX = Math.min(...items.map((i) => i.x));
  const minY = Math.min(...items.map((i) => i.y));
  const maxX = Math.max(...items.map((i) => i.x + i.width));
  const maxY = Math.max(...items.map((i) => i.y + i.height));
  const shifted = items.map((item) => ({
    ...item,
    x: item.x - minX + DIAGRAM_PAD,
    y: item.y - minY + DIAGRAM_PAD,
  }));
  return {
    items: shifted,
    width: Math.max(
      maxX - minX + DIAGRAM_PAD + rightMargin,
      CARD_WIDTH + DIAGRAM_PAD + rightMargin
    ),
    height: Math.max(maxY - minY + DIAGRAM_PAD * 2, 120),
  };
}

function tableCenterY(item: LayoutItem): number {
  return item.y + item.height / 2;
}

function groupItemsIntoColumns(items: LayoutItem[], numColumns: number) {
  const cols: LayoutItem[][] = Array.from({ length: numColumns }, () => []);
  for (const item of items) cols[item.column]!.push(item);
  for (const col of cols) col.sort((a, b) => a.y - b.y);
  return cols;
}

function buildRelationNeighbors(relations: DiagramRelation[]) {
  const neighbors = new Map<string, string[]>();
  for (const relation of relations) {
    const from = neighbors.get(relation.fromTable) ?? [];
    from.push(relation.toTable);
    neighbors.set(relation.fromTable, from);

    const to = neighbors.get(relation.toTable) ?? [];
    to.push(relation.fromTable);
    neighbors.set(relation.toTable, to);
  }
  return neighbors;
}

function barycenterTowardColumn(
  item: LayoutItem,
  relationNeighbors: Map<string, string[]>,
  itemByKey: Map<string, LayoutItem>,
  neighborCol: number
): number | null {
  const ys: number[] = [];
  for (const neighborKey of relationNeighbors.get(item.key) ?? []) {
    const neighbor = itemByKey.get(neighborKey);
    if (neighbor?.column === neighborCol) ys.push(tableCenterY(neighbor));
  }
  if (ys.length === 0) return null;
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}

function sortColumnByNeighborBarycenter(
  colItems: LayoutItem[],
  relationNeighbors: Map<string, string[]>,
  itemByKey: Map<string, LayoutItem>,
  neighborCol: number
): LayoutItem[] {
  return colItems.slice().sort((a, b) => {
    const ba = barycenterTowardColumn(
      a,
      relationNeighbors,
      itemByKey,
      neighborCol
    );
    const bb = barycenterTowardColumn(
      b,
      relationNeighbors,
      itemByKey,
      neighborCol
    );
    if (ba !== null && bb !== null && ba !== bb) return ba - bb;
    if (ba !== null && bb === null) return -1;
    if (ba === null && bb !== null) return 1;
    return a.key.localeCompare(b.key);
  });
}

function restackColumns(
  columns: LayoutItem[][],
  colXs: number[],
  rowGap: number
): LayoutItem[] {
  const out: LayoutItem[] = [];
  for (let c = 0; c < columns.length; c++) {
    let y = DIAGRAM_PAD;
    for (const item of columns[c]!) {
      out.push({ ...item, x: colXs[c]!, y, column: c });
      y += item.height + rowGap;
    }
  }
  return out;
}

function minimizeCrossingsVertical(
  items: LayoutItem[],
  relations: DiagramRelation[],
  numColumns: number,
  colXs: number[],
  rowGap: number
): LayoutItem[] {
  if (numColumns <= 1 || relations.length === 0) return items;
  const relationNeighbors = buildRelationNeighbors(relations);
  let current = items;
  for (let pass = 0; pass < 6; pass++) {
    const byKey = new Map(current.map((i) => [i.key, i]));
    const cols = groupItemsIntoColumns(current, numColumns);
    if (pass % 2 === 0) {
      for (let c = 1; c < numColumns; c++)
        cols[c] = sortColumnByNeighborBarycenter(
          cols[c]!,
          relationNeighbors,
          byKey,
          c - 1
        );
    } else {
      for (let c = numColumns - 2; c >= 0; c--)
        cols[c] = sortColumnByNeighborBarycenter(
          cols[c]!,
          relationNeighbors,
          byKey,
          c + 1
        );
    }
    current = restackColumns(cols, colXs, rowGap);
  }
  return current;
}

/** Column layout of the tables, ordered to keep related tables close. */
export function buildDiagramLayout(
  tables: DiagramTable[],
  relations: DiagramRelation[],
  spacing: DiagramSpacing = DEFAULT_DIAGRAM_SPACING
): DiagramLayout {
  if (tables.length === 0)
    return {
      items: [],
      width: EMPTY_DIAGRAM_WIDTH,
      height: EMPTY_DIAGRAM_HEIGHT,
    };
  const degree = new Map<string, number>();
  for (const table of tables) degree.set(tableKey(table.schema, table.name), 0);
  for (const relation of relations) {
    degree.set(relation.fromTable, (degree.get(relation.fromTable) ?? 0) + 1);
    degree.set(relation.toTable, (degree.get(relation.toTable) ?? 0) + 1);
  }
  const numColumns = chooseColumnCount(tables.length);
  const colXs = columnXPositions(numColumns, spacing.columnGap);
  const columns: DiagramTable[][] = Array.from(
    { length: numColumns },
    () => []
  );
  const sorted = tables.slice().sort((a, b) => {
    const d =
      (degree.get(tableKey(b.schema, b.name)) ?? 0) -
      (degree.get(tableKey(a.schema, a.name)) ?? 0);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  sorted.forEach((table, i) => columns[i % numColumns]!.push(table));
  const items: LayoutItem[] = [];
  columns.forEach((columnTables, columnIndex) => {
    let y = DIAGRAM_PAD;
    for (const table of columnTables) {
      const height = estimateCardHeight(table.columns.length);
      items.push({
        key: tableKey(table.schema, table.name),
        table,
        x: colXs[columnIndex]!,
        y,
        width: CARD_WIDTH,
        height,
        column: columnIndex,
      });
      y += height + spacing.rowGap;
    }
  });
  const untangled = minimizeCrossingsVertical(
    items,
    relations,
    numColumns,
    colXs,
    spacing.rowGap
  );
  return normalizeLayoutBounds(untangled, spacing.rightMargin);
}

/** Vertical middle of a column's row in its card, or of the card when not found. */
export function yMidForTableColumn(
  item: LayoutItem,
  columnName?: string
): number {
  const fallback = item.y + item.height / 2;
  const raw = columnName?.trim();
  if (!raw) return fallback;
  const idx = item.table.columns.findIndex(
    (c) => c.name.trim().toLowerCase() === raw.toLowerCase()
  );
  if (idx < 0) return fallback;
  return item.y + HEADER_HEIGHT + idx * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export function roundedOrthogonalPath(
  points: Array<{ x: number; y: number }>,
  radius: number,
  /** Straight length kept at both ends (for the cardinality marks). */
  endClearance = 0
): string {
  if (points.length < 2) return "";
  const path: string[] = [`M ${points[0]!.x} ${points[0]!.y}`];
  const lastIndex = points.length - 1;
  for (let i = 1; i < lastIndex; i += 1) {
    const prev = points[i - 1]!,
      curr = points[i]!,
      next = points[i + 1]!;
    const inDx = curr.x - prev.x,
      inDy = curr.y - prev.y,
      outDx = next.x - curr.x,
      outDy = next.y - curr.y;
    const inLen = Math.hypot(inDx, inDy),
      outLen = Math.hypot(outDx, outDy);
    if (!inLen || !outLen) continue;
    // A corner next to an end never eats into the end's straight stub.
    const inRoom = i === 1 ? inLen - endClearance : inLen / 2;
    const outRoom = i + 1 === lastIndex ? outLen - endClearance : outLen / 2;
    const trim = Math.max(0, Math.min(radius, inRoom, outRoom));
    if (trim === 0) {
      path.push(`L ${curr.x} ${curr.y}`);
      continue;
    }
    const sx = curr.x - (inDx / inLen) * trim,
      sy = curr.y - (inDy / inLen) * trim;
    const ex = curr.x + (outDx / outLen) * trim,
      ey = curr.y + (outDy / outLen) * trim;
    path.push(`L ${sx} ${sy}`, `Q ${curr.x} ${curr.y} ${ex} ${ey}`);
  }
  const last = points[lastIndex]!;
  path.push(`L ${last.x} ${last.y}`);
  return path.join(" ");
}

/** Drops repeated points and merges collinear runs, keeping the path orthogonal. */
function simplifyPoints(points: Array<{ x: number; y: number }>) {
  const out: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    const beforeLast = out[out.length - 2];
    if (
      last &&
      beforeLast &&
      ((beforeLast.x === last.x && last.x === point.x) ||
        (beforeLast.y === last.y && last.y === point.y))
    ) {
      out[out.length - 1] = point;
      continue;
    }
    out.push(point);
  }
  return out;
}

function segmentsOf(points: Array<{ x: number; y: number }>): DiagramRect[] {
  return points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return {
      x: Math.min(previous.x, point.x),
      y: Math.min(previous.y, point.y),
      width: Math.max(1, Math.abs(point.x - previous.x)),
      height: Math.max(1, Math.abs(point.y - previous.y)),
    };
  });
}

/** Center-out lane offsets: 0, +1, -1, +2, -2, ... (in lane units). */
function laneOffset(slot: number) {
  if (slot === 0) return 0;
  const step = Math.ceil(slot / 2);
  return slot % 2 === 1 ? step : -step;
}

type Interval = { lo: number; hi: number };

/** A horizontal run entering a gutter from its low or high side, up to lane `x`. */
type GutterStub = { y: number; side: "lo" | "hi"; x: number; bundle: string };

/** A vertical run in a lane, or a crossing row, owned by a bundle of relations. */
type Bundled = { bundle: string };

type Point = { x: number; y: number };

function overlaps(intervals: Interval[], span: Interval, clearance: number) {
  return intervals.some(
    (other) => span.lo < other.hi + clearance && span.hi > other.lo - clearance
  );
}

/** Lanes the router needed beyond what the layout's spacing offers. */
type SpacingDemand = {
  /** Most vertical lanes needed in one inner gutter, and in the right margin. */
  gutterLanes: number;
  marginLanes: number;
  /** Most horizontal lanes needed through one gap between two cards. */
  gapLanes: number;
};

/** Straight length kept next to each card for the cardinality marks. */
export const MARK_CLEARANCE = GUTTER_EDGE_MARGIN;
/** Vertical runs sharing a lane keep at least this distance apart. */
const LANE_CLEARANCE = 4;

/**
 * Free space of a layout: the gutters beside each column and the gaps between the cards
 * of each column. Lanes are handed out against what already occupies them, so two runs
 * share a coordinate only when their spans are apart; any shortfall is recorded so the
 * layout can be widened and routed again.
 */
class RoutingGrid {
  readonly numColumns: number;
  private readonly columnLeft: number[];
  private readonly gaps: Interval[][];
  /** Per gutter: per lane index, the y spans already running in it. */
  private readonly gutterLanes = new Map<
    number,
    Array<Array<Interval & Bundled>>
  >();
  /** Per gutter and bundle: the lane the bundle's trunk took first. */
  private readonly bundleLanes = new Map<string, number>();
  /** Per gutter: horizontal runs reaching into it from either side. */
  private readonly gutterStubs = new Map<number, GutterStub[]>();
  /** Per gutter: horizontal steps between two lanes of one relation. */
  private readonly gutterJogs = new Map<
    number,
    Array<{ y: number; lo: number; hi: number } & Bundled>
  >();
  /** Per column: rows already crossing it, and by which bundle. */
  private readonly crossings = new Map<
    number,
    Array<{ y: number } & Bundled>
  >();
  overflow = false;
  readonly demand: SpacingDemand = {
    gutterLanes: 0,
    marginLanes: 0,
    gapLanes: 0,
  };

  constructor(
    items: LayoutItem[],
    private readonly width: number,
    private readonly height: number
  ) {
    this.numColumns = items.reduce(
      (max, item) => Math.max(max, item.column + 1),
      0
    );
    this.columnLeft = Array.from({ length: this.numColumns }, (_, column) =>
      Math.min(
        ...items.filter((item) => item.column === column).map((item) => item.x)
      )
    );
    this.gaps = Array.from({ length: this.numColumns }, (_, column) => {
      const cards = items
        .filter((item) => item.column === column)
        .sort((a, b) => a.y - b.y);
      const free: Interval[] = [];
      let top = GAP_CARD_MARGIN / 2;
      for (const card of cards) {
        free.push({ lo: top, hi: card.y - GAP_CARD_MARGIN });
        top = card.y + card.height + GAP_CARD_MARGIN;
      }
      free.push({ lo: top, hi: height - GAP_CARD_MARGIN / 2 });
      return free.filter((gap) => gap.lo <= gap.hi);
    });
  }

  /** Gutter `g` lies between column g and g + 1; -1 and the last index are the margins. */
  private gutterBounds(gutter: number): Interval {
    const lo = gutter < 0 ? 0 : this.columnLeft[gutter]! + CARD_WIDTH;
    const hi =
      gutter + 1 < this.numColumns ? this.columnLeft[gutter + 1]! : this.width;
    return { lo, hi };
  }

  /**
   * A way through `gutter` from `entry` to `exit`: each is a horizontal run joining the
   * gutter from its low (left) or high (right) side at a row. Usually one vertical lane;
   * when every single lane would put an entry or exit run on top of a run another
   * relation brings in from the opposite side on the same row, the passage steps across
   * between two lanes on a free row (a jog). Returns the points inside the gutter.
   *
   * Relations of one bundle (leaving or reaching the same row of the same card) may
   * share runs: they reuse the bundle's lane and ignore each other's stubs and jogs, so
   * a hub fans out from one trunk instead of one lane per relation.
   */
  takeGutterPassage(
    gutter: number,
    entry: { y: number; side: "lo" | "hi" },
    exit: { y: number; side: "lo" | "hi" },
    bundle: string
  ): Point[] {
    const { lo, hi } = this.gutterBounds(gutter);
    const center = (lo + hi) / 2;
    const half = Math.max(0, (hi - lo) / 2 - GUTTER_EDGE_MARGIN);
    const capacity = Math.floor(half / GUTTER_LANE_SPACING) * 2 + 1;
    const lanes = this.gutterLanes.get(gutter) ?? [];
    this.gutterLanes.set(gutter, lanes);
    const stubs = this.gutterStubs.get(gutter) ?? [];
    this.gutterStubs.set(gutter, stubs);
    const jogs = this.gutterJogs.get(gutter) ?? [];
    this.gutterJogs.set(gutter, jogs);
    const xOf = (lane: number) =>
      center + laneOffset(lane) * GUTTER_LANE_SPACING;
    const spanOf = (y1: number, y2: number) => ({
      lo: Math.min(y1, y2),
      hi: Math.max(y1, y2),
    });
    const verticalFree = (lane: number, y1: number, y2: number) =>
      !lanes[lane] ||
      !overlaps(
        lanes[lane]!.filter((run) => run.bundle !== bundle),
        spanOf(y1, y2),
        LANE_CLEARANCE
      );
    // An entry/exit run from the low side covers [lo, x]; from the high side [x, hi].
    const runOf = (side: "lo" | "hi", x: number): Interval =>
      side === "lo" ? { lo, hi: x } : { lo: x, hi };
    const sameRow = (a: number, b: number) => Math.abs(a - b) < LANE_CLEARANCE;
    const stubFits = (stub: { y: number; side: "lo" | "hi" }, x: number) => {
      const run = runOf(stub.side, x);
      return (
        stubs.every(
          (other) =>
            other.bundle === bundle ||
            other.side === stub.side ||
            !sameRow(other.y, stub.y) ||
            (stub.side === "lo"
              ? other.x >= x + GUTTER_LANE_SPACING
              : x >= other.x + GUTTER_LANE_SPACING)
        ) &&
        jogs.every(
          (jog) =>
            jog.bundle === bundle ||
            !sameRow(jog.y, stub.y) ||
            jog.hi <= run.lo ||
            jog.lo >= run.hi
        )
      );
    };
    const jogFits = (y: number, x1: number, x2: number) => {
      const run = spanOf(x1, x2);
      return (
        stubs.every((stub) => {
          if (stub.bundle === bundle || !sameRow(stub.y, y)) return true;
          const other = runOf(stub.side, stub.x);
          return other.hi <= run.lo || other.lo >= run.hi;
        }) &&
        jogs.every(
          (jog) =>
            jog.bundle === bundle ||
            !sameRow(jog.y, y) ||
            jog.hi <= run.lo ||
            jog.lo >= run.hi
        )
      );
    };
    const commit = (
      parts: Array<{ lane: number; y1: number; y2: number }>,
      jog?: { y: number; x1: number; x2: number }
    ) => {
      for (const part of parts)
        (lanes[part.lane] ??= []).push({
          ...spanOf(part.y1, part.y2),
          bundle,
        });
      stubs.push(
        { ...entry, x: xOf(parts[0]!.lane), bundle },
        { ...exit, x: xOf(parts[parts.length - 1]!.lane), bundle }
      );
      if (jog) jogs.push({ y: jog.y, ...spanOf(jog.x1, jog.x2), bundle });
      if (!this.bundleLanes.has(trunkKey))
        this.bundleLanes.set(trunkKey, parts[0]!.lane);
      this.noteDemand(gutter, Math.max(...parts.map((part) => part.lane)) + 1);
    };

    // 1. A single lane, the bundle's own first.
    const trunkKey = `${gutter}|${bundle}`;
    const trunk = this.bundleLanes.get(trunkKey);
    const singleLanes = Array.from({ length: capacity }, (_, lane) => lane);
    if (trunk !== undefined && trunk < capacity) singleLanes.unshift(trunk);
    for (const lane of singleLanes) {
      const x = xOf(lane);
      if (
        verticalFree(lane, entry.y, exit.y) &&
        stubFits(entry, x) &&
        stubFits(exit, x)
      ) {
        commit([{ lane, y1: entry.y, y2: exit.y }]);
        return [
          { x, y: entry.y },
          { x, y: exit.y },
        ];
      }
    }

    // 2. Two lanes joined by a jog on a free row, nearest the middle first.
    const middle = (entry.y + exit.y) / 2;
    const jogRows: number[] = [];
    for (let step = 1; jogRows.length < 48 && step < 400; step++) {
      const offset = laneOffset(step) * GAP_LANE_SPACING;
      const y = middle + offset;
      if (y <= GAP_LANE_SPACING || y >= this.height - GAP_LANE_SPACING)
        continue;
      if (sameRow(y, entry.y) || sameRow(y, exit.y)) continue;
      jogRows.push(y);
    }
    for (const y of jogRows) {
      for (let first = 0; first < capacity; first++) {
        const x1 = xOf(first);
        if (!verticalFree(first, entry.y, y) || !stubFits(entry, x1)) continue;
        for (let second = 0; second < capacity; second++) {
          if (second === first) continue;
          const x2 = xOf(second);
          if (
            verticalFree(second, y, exit.y) &&
            stubFits(exit, x2) &&
            jogFits(y, x1, x2)
          ) {
            commit(
              [
                { lane: first, y1: entry.y, y2: y },
                { lane: second, y1: y, y2: exit.y },
              ],
              { y, x1, x2 }
            );
            return [
              { x: x1, y: entry.y },
              { x: x1, y },
              { x: x2, y },
              { x: x2, y: exit.y },
            ];
          }
        }
      }
    }

    // 3. No room: record how many lanes a single run needs, share the outermost lane,
    // and let the layout be widened.
    let lane = capacity;
    while (!verticalFree(lane, entry.y, exit.y)) lane++;
    this.overflow = true;
    commit([{ lane, y1: entry.y, y2: exit.y }]);
    const x = xOf(capacity - 1);
    return [
      { x, y: entry.y },
      { x, y: exit.y },
    ];
  }

  private noteDemand(gutter: number, lanes: number) {
    const isMargin = gutter < 0 || gutter + 1 >= this.numColumns;
    if (isMargin)
      this.demand.marginLanes = Math.max(this.demand.marginLanes, lanes);
    else this.demand.gutterLanes = Math.max(this.demand.gutterLanes, lanes);
  }

  /**
   * A y crossing `column` through a gap between its cards: on the straight line when it
   * is free, otherwise mid-gap. A crossing runs on into the gutters on both sides, so it
   * also avoids the rows other bundles use to cross the neighbouring columns. A bundle
   * crosses each column once: its later relations reuse that row.
   */
  takeGapY(column: number, desired: number, bundle: string): number {
    const used = this.crossings.get(column) ?? [];
    this.crossings.set(column, used);
    const shared = used.find((other) => other.bundle === bundle);
    if (shared) return shared.y;
    const blocking = [column - 1, column, column + 1].flatMap((c) =>
      (this.crossings.get(c) ?? []).filter((other) => other.bundle !== bundle)
    );
    const gaps = (this.gaps[column] ?? [])
      .map((gap) => ({
        gap,
        distance: Math.abs(
          Math.min(gap.hi, Math.max(gap.lo, desired)) - desired
        ),
      }))
      .sort((a, b) => a.distance - b.distance);

    for (const { gap } of gaps) {
      const preferred =
        desired >= gap.lo && desired <= gap.hi
          ? desired
          : (gap.lo + gap.hi) / 2;
      const candidates: number[] = [];
      for (let y = gap.lo; y <= gap.hi + 1e-9; y += GAP_LANE_SPACING)
        candidates.push(y);
      candidates.sort(
        (a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b
      );
      const free = candidates.find((y) =>
        blocking.every(
          (other) => Math.abs(other.y - y) >= GAP_LANE_SPACING - 1e-9
        )
      );
      if (free !== undefined) {
        used.push({ y: free, bundle });
        const inGap = used.filter(
          (other) => other.y >= gap.lo && other.y <= gap.hi
        ).length;
        this.demand.gapLanes = Math.max(this.demand.gapLanes, inGap);
        return free;
      }
    }

    // Every gap of the column is full: share the nearest coordinate; the layout gets
    // widened.
    this.overflow = true;
    const nearest = gaps[0]?.gap;
    this.demand.gapLanes = Math.max(this.demand.gapLanes, used.length + 1);
    const y = nearest
      ? Math.min(nearest.hi, Math.max(nearest.lo, desired))
      : desired;
    used.push({ y, bundle });
    return y;
  }
}

function geometryOf(
  points: Array<{ x: number; y: number }>,
  enterFrom: "left" | "right",
  fromRight: boolean
): RelationGeometry {
  const simplified = simplifyPoints(points);
  const first = simplified[0]!;
  const last = simplified[simplified.length - 1]!;
  return {
    path: roundedOrthogonalPath(simplified, REL_CORNER_RADIUS, MARK_CLEARANCE),
    points: simplified,
    startX: first.x,
    startY: first.y,
    endX: last.x,
    endY: last.y,
    enterFrom,
    fromRight,
    segments: segmentsOf(simplified),
  };
}

export type RoutedDiagram = {
  routes: Array<RelationGeometry | null>;
  /** True when some lanes still had to be shared after widening. */
  overflow: boolean;
  demand: SpacingDemand;
};

/**
 * Routes every relation through the free space of the layout. `routes` is indexed like
 * `relations`; a relation whose tables are not in the layout gets `null`.
 */
export function routeDiagramRelations(
  layout: DiagramLayout,
  relations: DiagramRelation[]
): RoutedDiagram {
  const itemByKey = new Map(layout.items.map((item) => [item.key, item]));
  const grid = new RoutingGrid(layout.items, layout.width, layout.height);

  // Route shorter spans first so they take the lanes nearest to the straight line.
  const order = relations
    .map((relation, index) => ({ relation, index }))
    .sort((a, b) => {
      const span = (relation: DiagramRelation) => {
        const from = itemByKey.get(relation.fromTable);
        const to = itemByKey.get(relation.toTable);
        return from && to ? Math.abs(from.column - to.column) : Infinity;
      };
      return span(a.relation) - span(b.relation) || a.index - b.index;
    });

  // Each relation joins the bundle of its busier end: the card row and side it leaves
  // or enters by. Relations of one bundle share trunks, so a referenced key fans out
  // from one line instead of one lane per foreign key.
  const portsOf = (relation: DiagramRelation) => {
    const from = itemByKey.get(relation.fromTable);
    const to = itemByKey.get(relation.toTable);
    if (!from || !to) return null;
    const loopsLeft =
      from.column === to.column &&
      from.column === grid.numColumns - 1 &&
      from.column > 0;
    const rightward =
      from.column === to.column ? !loopsLeft : to.column > from.column;
    return {
      source: `${from.key}|${yMidForTableColumn(from, relation.fromColumn)}|${rightward ? "r" : "l"}`,
      target: `${to.key}|${yMidForTableColumn(to, relation.toColumn)}|${
        from.column === to.column
          ? loopsLeft
            ? "l"
            : "r"
          : rightward
            ? "l"
            : "r"
      }`,
    };
  };
  const ports = relations.map(portsOf);
  const portUse = new Map<string, number>();
  for (const port of ports)
    if (port)
      for (const key of [`s:${port.source}`, `t:${port.target}`])
        portUse.set(key, (portUse.get(key) ?? 0) + 1);
  const bundleOf = (index: number) => {
    const port = ports[index]!;
    const source = `s:${port.source}`;
    const target = `t:${port.target}`;
    return portUse.get(target)! > portUse.get(source)! ? target : source;
  };

  const routes: Array<RelationGeometry | null> = relations.map(() => null);
  for (const { relation, index } of order) {
    const from = itemByKey.get(relation.fromTable);
    const to = itemByKey.get(relation.toTable);
    if (!from || !to) continue;
    const bundle = bundleOf(index);
    const startY = yMidForTableColumn(from, relation.fromColumn);
    let endY = yMidForTableColumn(to, relation.toColumn);

    if (from.column === to.column) {
      // Same column (including a table referencing itself): loop through a gutter
      // beside it, leaving and entering on that side. The last column uses its inner
      // gutter on the left, which is wider than the outer margin.
      const useLeft = from.column === grid.numColumns - 1 && from.column > 0;
      if (from === to && endY === startY) endY = startY + SELF_LOOP_DROP;
      const fromEdgeX = useLeft ? from.x : from.x + from.width;
      const toEdgeX = useLeft ? to.x : to.x + to.width;
      // The card edge is the gutter's high side when looping left, low side otherwise.
      const side = useLeft ? "hi" : "lo";
      const passage = grid.takeGutterPassage(
        useLeft ? from.column - 1 : from.column,
        { y: startY, side },
        { y: endY, side },
        bundle
      );
      routes[index] = geometryOf(
        [{ x: fromEdgeX, y: startY }, ...passage, { x: toEdgeX, y: endY }],
        useLeft ? "left" : "right",
        !useLeft
      );
      continue;
    }

    const direction = to.column > from.column ? 1 : -1;
    const startX = direction > 0 ? from.x + from.width : from.x;
    const endX = direction > 0 ? to.x : to.x + to.width;
    // Gutter on the exit side of a column, in the direction of travel.
    const gutterAfter = (column: number) =>
      direction > 0 ? column : column - 1;

    // Rows at which the relation crosses each column between the two tables, drifting
    // evenly toward the target row while staying in each column's free gaps.
    const crossYs: number[] = [];
    let currentY = startY;
    const intermediates: number[] = [];
    for (
      let column = from.column + direction;
      column !== to.column;
      column += direction
    )
      intermediates.push(column);
    intermediates.forEach((column, step) => {
      const remaining = intermediates.length - step;
      const desired = currentY + (endY - currentY) / (remaining + 1);
      currentY = grid.takeGapY(column, desired, bundle);
      crossYs.push(currentY);
    });

    // One vertical run per gutter: from the previous row to the next.
    const rows = [startY, ...crossYs, endY];
    const gutters = [from.column, ...intermediates].map(gutterAfter);
    const points = [{ x: startX, y: startY }];
    gutters.forEach((gutter, i) => {
      // Travelling right, the run arrives from the gutter's low side and leaves through
      // its high side; travelling left, the other way round.
      points.push(
        ...grid.takeGutterPassage(
          gutter,
          { y: rows[i]!, side: direction > 0 ? "lo" : "hi" },
          { y: rows[i + 1]!, side: direction > 0 ? "hi" : "lo" },
          bundle
        )
      );
    });
    points.push({ x: endX, y: endY });
    routes[index] = geometryOf(
      points,
      direction > 0 ? "left" : "right",
      direction > 0
    );
  }
  return { routes, overflow: grid.overflow, demand: grid.demand };
}

const MAX_COLUMN_GAP = 640;
const MAX_ROW_GAP = 480;

/** Gutter width giving `lanes` vertical lanes, laid out center-out (an odd count). */
function gutterRoomFor(lanes: number) {
  const perSide = Math.ceil(Math.max(0, lanes - 1) / 2);
  return 2 * (perSide * GUTTER_LANE_SPACING + GUTTER_EDGE_MARGIN) + 1;
}

/** Card gap giving `lanes` horizontal lanes. */
function gapRoomFor(lanes: number) {
  return Math.max(0, lanes - 1) * GAP_LANE_SPACING + 2 * GAP_CARD_MARGIN + 1;
}

/**
 * Lays the tables out and routes the relations, widening gutters and gaps until every
 * relation has a lane of its own (bounded by MAX_COLUMN_GAP / MAX_ROW_GAP; beyond that,
 * the most crowded lanes are shared).
 */
export function layoutDiagram(
  tables: DiagramTable[],
  relations: DiagramRelation[]
): {
  layout: DiagramLayout;
  routes: Array<RelationGeometry | null>;
  /** True when some lanes are still shared after the last widening pass. */
  overflow: boolean;
} {
  let spacing = DEFAULT_DIAGRAM_SPACING;
  let layout = buildDiagramLayout(tables, relations, spacing);
  let routed = routeDiagramRelations(layout, relations);
  for (let pass = 0; pass < 4 && routed.overflow; pass++) {
    const { demand } = routed;
    const next: DiagramSpacing = {
      columnGap: Math.min(
        MAX_COLUMN_GAP,
        Math.max(spacing.columnGap, gutterRoomFor(demand.gutterLanes))
      ),
      rowGap: Math.min(
        MAX_ROW_GAP,
        Math.max(spacing.rowGap, gapRoomFor(demand.gapLanes))
      ),
      rightMargin: Math.min(
        MAX_COLUMN_GAP,
        Math.max(spacing.rightMargin, gutterRoomFor(demand.marginLanes))
      ),
    };
    if (
      next.columnGap === spacing.columnGap &&
      next.rowGap === spacing.rowGap &&
      next.rightMargin === spacing.rightMargin
    )
      break;
    spacing = next;
    layout = buildDiagramLayout(tables, relations, spacing);
    routed = routeDiagramRelations(layout, relations);
  }
  return { layout, routes: routed.routes, overflow: routed.overflow };
}
