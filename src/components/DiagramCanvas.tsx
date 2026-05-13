import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { KeyIcon, MinusIcon, PlusIcon } from "src/components/icons";

type DiagramColumn = {
  name: string;
  type: string;
  isPrimaryKey?: boolean;
};

type DiagramTable = {
  schema: string;
  name: string;
  columns: DiagramColumn[];
};

type RelationCardinality = "one-to-one" | "one-to-many";

type DiagramRelation = {
  fromTable: string;
  toTable: string;
  label: string;
  fromColumn?: string;
  toColumn?: string;
  cardinality: RelationCardinality;
};

type DiagramState = {
  mermaid: string;
  tableCount: number;
  relationshipCount: number;
  tables: DiagramTable[];
  relations: DiagramRelation[];
};

type LayoutItem = {
  key: string;
  table: DiagramTable;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
};

const CARD_WIDTH = 280;
const HEADER_HEIGHT = 42;
const ROW_HEIGHT = 28;
const DIAGRAM_PAD = 32;
const EMPTY_DIAGRAM_WIDTH = 640;
const EMPTY_DIAGRAM_HEIGHT = 400;
const COLUMN_H_GAP = 56;
const REL_LANE_STAGGER = 14;
const ROW_GAP = 48;
const REL_STROKE_WIDTH = 0.85;
const REL_STROKE_HOVER = 1.35;
const HIT_STROKE = "transparent";
const HIT_FILL = "transparent";
const REL_HIT_STROKE_WIDTH = 4;
const CROW_HIT_STROKE_WIDTH = 10;
const CROW_INWARD = 5;
const CROW_BRANCH = 4;
const ONE_MARK_TICK = 5;
const ONE_MARK_INSET = 5;
const REL_CORNER_RADIUS = 10;
const O_MARK_R = 3.5;
const O_MARK_INSET = 9;
const O_HIT_R = 10;
const REL_FLOW_CLASS = "diagram-rel-flow";
const REL_FLOW_PARTICLE_CLASS = "diagram-rel-flow-particle";
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 2.75;
const ZOOM_STEP = 1.12;

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Chromium/WebKit: `zoom` is sharp like browser zoom. Use only with fixed clip + absolute surface (avoids overlap bugs). */
function browserSupportsCssZoom(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function")
    return false;
  try {
    return CSS.supports("zoom", "2");
  } catch {
    return false;
  }
}

const USE_CSS_ZOOM = browserSupportsCssZoom();

function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function estimateCardHeight(columnCount: number) {
  return HEADER_HEIGHT + Math.max(1, columnCount) * ROW_HEIGHT + 16;
}

function chooseColumnCount(tableCount: number): number {
  if (tableCount <= 1) return 1;
  return Math.min(12, Math.max(2, Math.ceil(tableCount / 6)));
}

function columnXPositions(numColumns: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < numColumns; i++)
    xs.push(DIAGRAM_PAD + i * (CARD_WIDTH + COLUMN_H_GAP));
  return xs;
}

function normalizeLayoutBounds(items: LayoutItem[]) {
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
      maxX - minX + DIAGRAM_PAD * 2,
      CARD_WIDTH + DIAGRAM_PAD * 2
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

function barycenterTowardColumn(
  item: LayoutItem,
  relations: DiagramRelation[],
  itemByKey: Map<string, LayoutItem>,
  neighborCol: number
): number | null {
  const ys: number[] = [];
  for (const rel of relations) {
    let other: LayoutItem | undefined;
    if (rel.fromTable === item.key) {
      const o = itemByKey.get(rel.toTable);
      if (o && o.column === neighborCol) other = o;
    }
    if (rel.toTable === item.key) {
      const o = itemByKey.get(rel.fromTable);
      if (o && o.column === neighborCol) other = o;
    }
    if (other) ys.push(tableCenterY(other));
  }
  if (ys.length === 0) return null;
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}

function sortColumnByNeighborBarycenter(
  colItems: LayoutItem[],
  relations: DiagramRelation[],
  itemByKey: Map<string, LayoutItem>,
  neighborCol: number
): LayoutItem[] {
  return colItems.slice().sort((a, b) => {
    const ba = barycenterTowardColumn(a, relations, itemByKey, neighborCol);
    const bb = barycenterTowardColumn(b, relations, itemByKey, neighborCol);
    if (ba !== null && bb !== null && ba !== bb) return ba - bb;
    if (ba !== null && bb === null) return -1;
    if (ba === null && bb !== null) return 1;
    return a.key.localeCompare(b.key);
  });
}

function restackColumns(
  columns: LayoutItem[][],
  colXs: number[]
): LayoutItem[] {
  const out: LayoutItem[] = [];
  for (let c = 0; c < columns.length; c++) {
    let y = DIAGRAM_PAD;
    for (const item of columns[c]!) {
      out.push({ ...item, x: colXs[c]!, y, column: c });
      y += item.height + ROW_GAP;
    }
  }
  return out;
}

function minimizeCrossingsVertical(
  items: LayoutItem[],
  relations: DiagramRelation[],
  numColumns: number,
  colXs: number[]
): LayoutItem[] {
  if (numColumns <= 1 || relations.length === 0) return items;
  let current = items;
  for (let pass = 0; pass < 6; pass++) {
    const byKey = new Map(current.map((i) => [i.key, i]));
    const cols = groupItemsIntoColumns(current, numColumns);
    if (pass % 2 === 0) {
      for (let c = 1; c < numColumns; c++)
        cols[c] = sortColumnByNeighborBarycenter(
          cols[c]!,
          relations,
          byKey,
          c - 1
        );
    } else {
      for (let c = numColumns - 2; c >= 0; c--)
        cols[c] = sortColumnByNeighborBarycenter(
          cols[c]!,
          relations,
          byKey,
          c + 1
        );
    }
    current = restackColumns(cols, colXs);
  }
  return current;
}

function buildLayout(tables: DiagramTable[], relations: DiagramRelation[]) {
  if (tables.length === 0)
    return {
      items: [] as LayoutItem[],
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
  const colXs = columnXPositions(numColumns);
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
      y += height + ROW_GAP;
    }
  });
  const untangled = minimizeCrossingsVertical(
    items,
    relations,
    numColumns,
    colXs
  );
  return normalizeLayoutBounds(untangled);
}

function yMidForTableColumn(item: LayoutItem, columnName?: string): number {
  const fallback = item.y + item.height / 2;
  const raw = columnName?.trim();
  if (!raw) return fallback;
  const idx = item.table.columns.findIndex(
    (c) => c.name.trim().toLowerCase() === raw.toLowerCase()
  );
  if (idx < 0) return fallback;
  return item.y + HEADER_HEIGHT + idx * ROW_HEIGHT + ROW_HEIGHT / 2;
}

type RelationGeometry = {
  path: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  enterFrom: "left" | "right";
  fromRight: boolean;
};

function roundedOrthogonalPath(
  points: Array<{ x: number; y: number }>,
  radius: number
): string {
  if (points.length < 2) return "";
  const path: string[] = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
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
    const trim = Math.min(radius, inLen / 2, outLen / 2);
    const sx = curr.x - (inDx / inLen) * trim,
      sy = curr.y - (inDy / inLen) * trim;
    const ex = curr.x + (outDx / outLen) * trim,
      ey = curr.y + (outDy / outLen) * trim;
    path.push(`L ${sx} ${sy}`, `Q ${curr.x} ${curr.y} ${ex} ${ey}`);
  }
  const last = points[points.length - 1]!;
  path.push(`L ${last.x} ${last.y}`);
  return path.join(" ");
}

function relationGeometry(
  from: LayoutItem,
  to: LayoutItem,
  relation: DiagramRelation,
  middleYOverride?: number
): RelationGeometry {
  const fromRight = from.column <= to.column;
  const startX = fromRight ? from.x + from.width : from.x;
  const startY = yMidForTableColumn(from, relation.fromColumn);
  const endX = fromRight ? to.x : to.x + to.width;
  const endY = yMidForTableColumn(to, relation.toColumn);
  const x1 = startX + (fromRight ? 26 : -26);
  const x2 = endX + (fromRight ? -26 : 26);
  const baseMiddleY = (startY + endY) / 2;
  const middleY = middleYOverride !== undefined ? middleYOverride : baseMiddleY;
  const path = roundedOrthogonalPath(
    [
      { x: startX, y: startY },
      { x: x1, y: startY },
      { x: x1, y: middleY },
      { x: x2, y: middleY },
      { x: x2, y: endY },
      { x: endX, y: endY },
    ],
    REL_CORNER_RADIUS
  );
  return {
    path,
    startX,
    startY,
    endX,
    endY,
    enterFrom: fromRight ? "left" : "right",
    fromRight,
  };
}

function computeRelationMiddleYByIndex(
  items: LayoutItem[],
  relations: DiagramRelation[]
): Map<number, number> {
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  type Edge = {
    index: number;
    colLo: number;
    colHi: number;
    baseMid: number;
  };
  const list: Edge[] = [];

  relations.forEach((rel, index) => {
    const from = itemByKey.get(rel.fromTable);
    const to = itemByKey.get(rel.toTable);
    if (!from || !to) return;
    const startY = yMidForTableColumn(from, rel.fromColumn);
    const endY = yMidForTableColumn(to, rel.toColumn);
    const baseMid = (startY + endY) / 2;
    const colLo = Math.min(from.column, to.column);
    const colHi = Math.max(from.column, to.column);
    list.push({ index, colLo, colHi, baseMid });
  });

  const byChannel = new Map<string, Edge[]>();
  for (const e of list) {
    const k = `${e.colLo}-${e.colHi}`;
    if (!byChannel.has(k)) byChannel.set(k, []);
    byChannel.get(k)!.push(e);
  }

  const out = new Map<number, number>();
  for (const [, group] of byChannel) {
    group.sort((a, b) =>
      a.baseMid !== b.baseMid ? a.baseMid - b.baseMid : a.index - b.index
    );
    const n = group.length;
    for (let i = 0; i < n; i++) {
      const e = group[i]!;
      const rel = relations[e.index]!;
      const from = itemByKey.get(rel.fromTable)!;
      const to = itemByKey.get(rel.toTable)!;
      const startY = yMidForTableColumn(from, rel.fromColumn);
      const endY = yMidForTableColumn(to, rel.toColumn);
      const delta = (i - (n - 1) / 2) * REL_LANE_STAGGER;
      let y = e.baseMid + delta;
      const loP = Math.min(startY, endY) - 36;
      const hiP = Math.max(startY, endY) + 36;
      y = Math.max(loP, Math.min(hiP, y));
      out.set(e.index, y);
    }
  }
  return out;
}

function crowFootLines(x: number, y: number, enterFrom: "left" | "right") {
  const baseX = x + (enterFrom === "left" ? -CROW_INWARD : CROW_INWARD);
  return [
    [baseX, y, x, y],
    [baseX, y, x, y - CROW_BRANCH],
    [baseX, y, x, y + CROW_BRANCH],
  ] as Array<[number, number, number, number]>;
}

function oneToManyParentTickGeometry(g: RelationGeometry) {
  const x = g.fromRight ? g.startX + ONE_MARK_INSET : g.startX - ONE_MARK_INSET;
  return { x, y1: g.startY - ONE_MARK_TICK, y2: g.startY + ONE_MARK_TICK };
}

function oneToOneCircleCenters(g: RelationGeometry) {
  return g.fromRight
    ? {
        startCx: g.startX + O_MARK_INSET,
        startCy: g.startY,
        endCx: g.endX - O_MARK_INSET,
        endCy: g.endY,
      }
    : {
        startCx: g.startX - O_MARK_INSET,
        startCy: g.startY,
        endCx: g.endX + O_MARK_INSET,
        endCy: g.endY,
      };
}

function relationHoverTitle(relation: DiagramRelation) {
  const fromShort = relation.fromTable.includes(".")
    ? relation.fromTable.slice(relation.fromTable.lastIndexOf(".") + 1)
    : relation.fromTable;
  const toShort = relation.toTable.includes(".")
    ? relation.toTable.slice(relation.toTable.lastIndexOf(".") + 1)
    : relation.toTable;
  return `${toShort}.${relation.toColumn ?? "?"} → ${fromShort}.${relation.fromColumn ?? "?"} (${relation.cardinality === "one-to-one" ? "1:1" : "1:n"})`;
}

export function DiagramCanvas(props: { state: DiagramState }) {
  const { state } = props;

  const [zoom, setZoom] = useState(1);
  const [hoveredRelIndex, setHoveredRelIndex] = useState<number | null>(null);
  const [hoveredTableKey, setHoveredTableKey] = useState<string | null>(null);

  const hoverLeaveTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const clearHoverLeaveTimer = () => {
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
  };

  const onRelationHoverEnter = (index: number) => {
    clearHoverLeaveTimer();
    setHoveredRelIndex(index);
  };

  const onRelationHoverLeave = () => {
    clearHoverLeaveTimer();
    hoverLeaveTimerRef.current = window.setTimeout(() => {
      setHoveredRelIndex(null);
      hoverLeaveTimerRef.current = null;
    }, 80);
  };

  useEffect(() => () => clearHoverLeaveTimer(), []);

  useEffect(() => {
    setZoom(1);
  }, [state.tables, state.relations]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      setZoom((z) => clampZoom(z * factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const layout = useMemo(
    () => buildLayout(state.tables, state.relations),
    [state.tables, state.relations]
  );

  const relationMiddleYByIndex = useMemo(
    () => computeRelationMiddleYByIndex(layout.items, state.relations),
    [layout.items, state.relations]
  );

  const itemByKey = useMemo(
    () => new Map(layout.items.map((item) => [item.key, item])),
    [layout.items]
  );

  const hoveredRelation =
    hoveredRelIndex !== null ? state.relations[hoveredRelIndex] : null;

  const isRelationActive = (relation: DiagramRelation, index: number) =>
    hoveredRelIndex === index ||
    (!!hoveredTableKey &&
      (hoveredTableKey === relation.fromTable ||
        hoveredTableKey === relation.toTable));

  const isTableHighlighted = (tableKey: string) =>
    hoveredTableKey === tableKey ||
    (!!hoveredRelation &&
      (tableKey === hoveredRelation.fromTable ||
        tableKey === hoveredRelation.toTable));

  const scaledW = layout.width * zoom;
  const scaledH = layout.height * zoom;
  const contentMinW = `max(100%, ${scaledW}px)`;

  return (
    <div class="flex h-full min-h-0 w-full max-w-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div class="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-2 py-[5px]">
        <h2 class="text-sm font-bold text-slate-600">Diagram</h2>
        <div class="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white shadow-sm">
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-35"
            title="Zoom out (or ⌃ scroll)"
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_MIN + 1e-6}
            onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))}
          >
            <MinusIcon class="size-4" stroke-width="2" />
          </button>
          <span class="min-w-13 px-1 text-center text-xs font-medium text-slate-600 tabular-nums select-none">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-35"
            title="Zoom in (or ⌃ scroll)"
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_MAX - 1e-6}
            onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))}
          >
            <PlusIcon class="size-4" stroke-width="2" />
          </button>
          <button
            type="button"
            class="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            title="Reset zoom"
            aria-label="Reset zoom to 100%"
            onClick={() => setZoom(1)}
          >
            Reset
          </button>
        </div>
      </div>
      <div ref={scrollRef} class="min-h-0 flex-1 overflow-auto">
        <div
          class="inline-block min-w-full align-top"
          style={{
            width: contentMinW,
          }}
        >
          <div
            class="relative mx-auto shrink-0 overflow-hidden"
            style={{ width: `${scaledW}px`, height: `${scaledH}px` }}
          >
            <div
              class={`absolute top-0 left-0 antialiased ${USE_CSS_ZOOM ? "" : "origin-top-left"}`}
              style={
                {
                  width: `${layout.width}px`,
                  height: `${layout.height}px`,
                  backgroundSize: "18px 18px",
                  backgroundColor: "#fcfcfd",
                  backgroundImage:
                    "radial-gradient(#e2e8f0 1px, transparent 1px), radial-gradient(#e2e8f0 1px, transparent 1px)",
                  backgroundPosition: "0 0, 9px 9px",
                  ...(USE_CSS_ZOOM
                    ? { zoom }
                    : {
                        transform: `translate3d(0,0,0) scale(${zoom})`,
                      }),
                } as Record<string, string | number>
              }
            >
              {layout.items.map((item) => (
                <div
                  key={item.key}
                  class={`absolute z-1 overflow-hidden rounded-xl border bg-white shadow-[0_10px_24px_rgba(15,23,42,0.06)] transition-shadow duration-150 ${isTableHighlighted(item.key) ? "border-sky-500 shadow-[0_0_0_2px_rgba(14,165,233,0.45),0_10px_24px_rgba(15,23,42,0.08)]" : "border-slate-200"}`}
                  style={{
                    left: `${item.x}px`,
                    top: `${item.y}px`,
                    width: `${item.width}px`,
                  }}
                  onMouseEnter={() => setHoveredTableKey(item.key)}
                  onMouseLeave={() =>
                    setHoveredTableKey((k) => (k === item.key ? null : k))
                  }
                >
                  <div class="border-b border-slate-200 bg-slate-50 px-4 py-3 text-center text-sm font-semibold text-slate-800">
                    {item.table.name}
                  </div>
                  <div class="divide-y divide-slate-100">
                    {item.table.columns.map((column) => (
                      <div
                        key={column.name}
                        class="flex items-center justify-between gap-3 px-4 py-2 text-xs"
                      >
                        <span class="flex min-w-0 flex-1 items-center gap-1.5 truncate text-slate-700">
                          <span class="min-w-0 truncate">{column.name}</span>
                          {column.isPrimaryKey ? (
                            <KeyIcon
                              className="size-3 shrink-0 text-slate-500"
                              aria-label="Primary key"
                            />
                          ) : null}
                        </span>
                        <span class="shrink-0 font-medium text-slate-400">
                          {column.type || "unknown"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <svg
                class="pointer-events-none absolute inset-0 z-100 overflow-visible"
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                shape-rendering="geometricPrecision"
              >
                <defs>
                  <mask id="diagram-rel-mask" maskUnits="userSpaceOnUse">
                    <rect
                      x={0}
                      y={0}
                      width={layout.width}
                      height={layout.height}
                      fill="white"
                    />
                    {layout.items.map((item) => (
                      <rect
                        key={`mask-${item.key}`}
                        x={item.x - 1}
                        y={item.y - 1}
                        width={item.width + 2}
                        height={item.height + 2}
                        rx={12}
                        ry={12}
                        fill="black"
                      />
                    ))}
                  </mask>
                </defs>
                {state.relations.map((relation, index) => {
                  const from = itemByKey.get(relation.fromTable);
                  const to = itemByKey.get(relation.toTable);
                  if (!from || !to) return null;
                  const g = relationGeometry(
                    from,
                    to,
                    relation,
                    relationMiddleYByIndex.get(index)
                  );
                  const isHover = isRelationActive(relation, index);
                  const strokeColor = isHover ? "#0284c7" : "#94a3b8";
                  const strokeW = isHover ? REL_STROKE_HOVER : REL_STROKE_WIDTH;
                  const crow = crowFootLines(g.endX, g.endY, g.enterFrom);
                  const gk = `${relation.fromTable}-${relation.toTable}-${index}`;
                  const tip = relationHoverTitle(relation);
                  if (relation.cardinality === "one-to-one") {
                    const o = oneToOneCircleCenters(g);
                    return (
                      <g key={gk}>
                        <path
                          d={g.path}
                          fill="none"
                          stroke={HIT_STROKE}
                          stroke-width={REL_HIT_STROKE_WIDTH}
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          class="cursor-pointer"
                          style={{ pointerEvents: "stroke" }}
                          onMouseEnter={() => onRelationHoverEnter(index)}
                          onMouseLeave={onRelationHoverLeave}
                        >
                          <title>{tip}</title>
                        </path>
                        <circle
                          cx={o.startCx}
                          cy={o.startCy}
                          r={O_HIT_R}
                          fill={HIT_FILL}
                          class="cursor-pointer"
                          style={{ pointerEvents: "fill" }}
                          onMouseEnter={() => onRelationHoverEnter(index)}
                          onMouseLeave={onRelationHoverLeave}
                        >
                          <title>{tip}</title>
                        </circle>
                        <circle
                          cx={o.endCx}
                          cy={o.endCy}
                          r={O_HIT_R}
                          fill={HIT_FILL}
                          class="cursor-pointer"
                          style={{ pointerEvents: "fill" }}
                          onMouseEnter={() => onRelationHoverEnter(index)}
                          onMouseLeave={onRelationHoverLeave}
                        >
                          <title>{tip}</title>
                        </circle>
                        <g mask="url(#diagram-rel-mask)">
                          <path
                            d={g.path}
                            fill="none"
                            stroke={strokeColor}
                            stroke-width={strokeW}
                            style={{ pointerEvents: "none" }}
                          />
                          {isHover ? (
                            <>
                              <path
                                d={g.path}
                                fill="none"
                                stroke={strokeColor}
                                stroke-width={2}
                                class={REL_FLOW_CLASS}
                                style={{ pointerEvents: "none" }}
                              />
                              <path
                                d={g.path}
                                fill="none"
                                stroke={strokeColor}
                                class={REL_FLOW_PARTICLE_CLASS}
                                style={{ pointerEvents: "none" }}
                              />
                            </>
                          ) : null}
                          <circle
                            cx={o.startCx}
                            cy={o.startCy}
                            r={O_MARK_R}
                            fill="none"
                            stroke={strokeColor}
                            stroke-width={strokeW}
                            style={{ pointerEvents: "none" }}
                          />
                          <circle
                            cx={o.endCx}
                            cy={o.endCy}
                            r={O_MARK_R}
                            fill="none"
                            stroke={strokeColor}
                            stroke-width={strokeW}
                            style={{ pointerEvents: "none" }}
                          />
                        </g>
                      </g>
                    );
                  }
                  const tick = oneToManyParentTickGeometry(g);
                  return (
                    <g key={gk}>
                      <path
                        d={g.path}
                        fill="none"
                        stroke={HIT_STROKE}
                        stroke-width={REL_HIT_STROKE_WIDTH}
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="cursor-pointer"
                        style={{ pointerEvents: "stroke" }}
                        onMouseEnter={() => onRelationHoverEnter(index)}
                        onMouseLeave={onRelationHoverLeave}
                      >
                        <title>{tip}</title>
                      </path>
                      <line
                        x1={tick.x}
                        y1={tick.y1}
                        x2={tick.x}
                        y2={tick.y2}
                        stroke={HIT_STROKE}
                        stroke-width={12}
                        stroke-linecap="round"
                        class="cursor-pointer"
                        style={{ pointerEvents: "stroke" }}
                        onMouseEnter={() => onRelationHoverEnter(index)}
                        onMouseLeave={onRelationHoverLeave}
                      />
                      {crow.map(([x1, y1, x2, y2], i) => (
                        <line
                          key={`${gk}-crow-hit-${i}`}
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke={HIT_STROKE}
                          stroke-width={CROW_HIT_STROKE_WIDTH}
                          stroke-linecap="round"
                          class="cursor-pointer"
                          style={{ pointerEvents: "stroke" }}
                          onMouseEnter={() => onRelationHoverEnter(index)}
                          onMouseLeave={onRelationHoverLeave}
                        />
                      ))}
                      <g mask="url(#diagram-rel-mask)">
                        <path
                          d={g.path}
                          fill="none"
                          stroke={strokeColor}
                          stroke-width={strokeW}
                          style={{ pointerEvents: "none" }}
                        />
                        {isHover ? (
                          <>
                            <path
                              d={g.path}
                              fill="none"
                              stroke={strokeColor}
                              stroke-width={2.1}
                              class={REL_FLOW_CLASS}
                              style={{ pointerEvents: "none" }}
                            />
                            <path
                              d={g.path}
                              fill="none"
                              stroke={strokeColor}
                              class={REL_FLOW_PARTICLE_CLASS}
                              style={{ pointerEvents: "none" }}
                            />
                          </>
                        ) : null}
                        <line
                          x1={tick.x}
                          y1={tick.y1}
                          x2={tick.x}
                          y2={tick.y2}
                          stroke={strokeColor}
                          stroke-width={strokeW}
                          stroke-linecap="round"
                          style={{ pointerEvents: "none" }}
                        />
                        {crow.map(([x1, y1, x2, y2], i) => (
                          <line
                            key={`${gk}-crow-${i}`}
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke={strokeColor}
                            stroke-width={strokeW}
                            stroke-linecap="round"
                            style={{ pointerEvents: "none" }}
                          />
                        ))}
                      </g>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
