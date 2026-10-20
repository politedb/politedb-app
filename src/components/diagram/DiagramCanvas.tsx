import { memo } from "preact/compat";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { OverlayScrollbars } from "src/components/common/OverlayScrollArea";
import {
  areDiagramViewportsEqual,
  DEFAULT_DIAGRAM_VIEWPORT,
  DIAGRAM_VIEWPORT_OVERSCAN,
  getDiagramSurfaceSize,
  getDiagramSvgViewBox,
  getDiagramViewport,
  getVisibleIndexWindow,
  isDiagramRectVisible,
  shouldRenderDiagramTableDetails,
} from "src/components/diagram/diagramViewport";
import {
  buildDiagramSpatialIndex,
  getDiagramSpatialCandidates,
} from "src/components/diagram/diagramSpatialIndex";
import {
  DownloadIcon,
  KeyIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
} from "src/components/icons";
import type {
  DiagramRelation,
  DiagramState,
} from "src/components/diagram/diagramTypes";
import { Button } from "src/components/common/Button";
import { Dropdown } from "src/components/common/Dropdown";
import { ProBadge } from "src/components/license/ProBadge";
import { useDiagramExport } from "src/components/diagram/useDiagramExport";
import {
  HEADER_HEIGHT,
  layoutDiagram,
  ROW_HEIGHT,
  type LayoutItem,
  type RelationGeometry,
} from "src/components/diagram/diagramLayout";

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
const O_MARK_R = 3.5;
const O_MARK_INSET = 9;
const O_HIT_R = 10;
const REL_FLOW_CLASS = "diagram-rel-flow";
const REL_FLOW_PARTICLE_CLASS = "diagram-rel-flow-particle";
const REL_IDLE_CLASS = "diagram-rel-idle";
const REL_ACTIVE_CLASS = "diagram-rel-active";
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
  return {
    startCx: g.fromRight ? g.startX + O_MARK_INSET : g.startX - O_MARK_INSET,
    startCy: g.startY,
    // Outward from the target card, on the side the relation enters.
    endCx:
      g.enterFrom === "left" ? g.endX - O_MARK_INSET : g.endX + O_MARK_INSET,
    endCy: g.endY,
  };
}

function diagramTableKeyFromTarget(target: EventTarget | null): string | null {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return (
    el?.closest("[data-diagram-table]")?.getAttribute("data-diagram-table") ??
    null
  );
}

const DiagramTableCard = memo(function DiagramTableCard(props: {
  item: LayoutItem;
  highlighted: boolean;
  columnStart: number;
  columnEnd: number;
}) {
  const { item, highlighted, columnStart, columnEnd } = props;
  const columns = item.table.columns;

  return (
    <div
      data-diagram-table={item.key}
      class={`diagram-table-card absolute z-1 overflow-hidden rounded-xl border bg-white ${
        highlighted ? "diagram-table-card-active" : ""
      }`}
      style={{
        left: `${item.x}px`,
        top: `${item.y}px`,
        width: `${item.width}px`,
        contain: "layout paint",
      }}
    >
      <div class="border-b border-slate-200 bg-slate-50 px-4 py-3 text-center text-sm font-semibold text-slate-800">
        {item.table.name}
      </div>
      <div>
        {columnStart > 0 ? (
          <div style={{ height: `${columnStart * ROW_HEIGHT}px` }} />
        ) : null}
        <div class="diagram-table-rows">
          {columns.slice(columnStart, columnEnd).map((column) => (
            <div
              key={column.name}
              data-diagram-column={column.name}
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
        {columnEnd < columns.length ? (
          <div
            style={{
              height: `${(columns.length - columnEnd) * ROW_HEIGHT}px`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
});

function relationHoverTitle(relation: DiagramRelation) {
  const fromShort = relation.fromTable.includes(".")
    ? relation.fromTable.slice(relation.fromTable.lastIndexOf(".") + 1)
    : relation.fromTable;
  const toShort = relation.toTable.includes(".")
    ? relation.toTable.slice(relation.toTable.lastIndexOf(".") + 1)
    : relation.toTable;
  return `${toShort}.${relation.toColumn ?? "?"} → ${fromShort}.${relation.fromColumn ?? "?"} (${relation.cardinality === "one-to-one" ? "1:1" : "1:n"})`;
}

export function DiagramCanvas(props: {
  state: DiagramState;
  /** Reloads the diagram from schema metadata. */
  loadDiagram?: () => void;
  /** Used to name exported files and in the JSON export. */
  database?: string;
  schema?: string;
}) {
  const { state, loadDiagram, database, schema } = props;
  const { exportPng, exportJson, exportSvg } = useDiagramExport({
    diagram: state,
    database,
    schema,
  });
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [hoveredRelIndex, setHoveredRelIndex] = useState<number | null>(null);
  const [hoveredTableKey, setHoveredTableKey] = useState<string | null>(null);
  const [viewport, setViewport] = useState(DEFAULT_DIAGRAM_VIEWPORT);

  const hoverLeaveTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewportFrameRef = useRef<number | null>(null);

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

  const diagram = useMemo(
    () => layoutDiagram(state.tables, state.relations),
    [state.tables, state.relations]
  );
  const layout = diagram.layout;

  const relationRenderItems = useMemo(
    () =>
      state.relations.flatMap((relation, index) => {
        const geometry = diagram.routes[index];
        return geometry ? [{ relation, index, geometry }] : [];
      }),
    [diagram, state.relations]
  );

  const cardSpatialIndex = useMemo(
    () => buildDiagramSpatialIndex(layout.items.map((item) => [item] as const)),
    [layout.items]
  );

  const relationSpatialIndex = useMemo(
    () =>
      buildDiagramSpatialIndex(
        relationRenderItems.map((item) => item.geometry.segments)
      ),
    [relationRenderItems]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateViewport = () => {
      viewportFrameRef.current = null;
      const next = getDiagramViewport(
        el.scrollLeft,
        el.scrollTop,
        el.clientWidth,
        el.clientHeight,
        zoom
      );
      setViewport((current) =>
        areDiagramViewportsEqual(current, next) ? current : next
      );
    };
    const scheduleViewportUpdate = () => {
      if (viewportFrameRef.current !== null) return;
      viewportFrameRef.current = window.requestAnimationFrame(updateViewport);
    };

    scheduleViewportUpdate();
    el.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleViewportUpdate);
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", scheduleViewportUpdate);
      observer.disconnect();
      if (viewportFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportFrameRef.current);
        viewportFrameRef.current = null;
      }
    };
  }, [layout.height, layout.width, zoom]);

  const showDetails = shouldRenderDiagramTableDetails(zoom);
  const svgBox = getDiagramSvgViewBox(viewport, layout.width, layout.height);

  const visibleCards = useMemo(() => {
    const rangeStart = viewport.top - DIAGRAM_VIEWPORT_OVERSCAN;
    const rangeEnd = viewport.top + viewport.height + DIAGRAM_VIEWPORT_OVERSCAN;
    return getDiagramSpatialCandidates(
      cardSpatialIndex,
      viewport,
      DIAGRAM_VIEWPORT_OVERSCAN
    ).flatMap((index) => {
      const item = layout.items[index];
      if (!item || !isDiagramRectVisible(item, viewport)) return [];
      const columnWindow = getVisibleIndexWindow(
        item.y + HEADER_HEIGHT,
        ROW_HEIGHT,
        item.table.columns.length,
        rangeStart,
        rangeEnd
      );
      return [
        {
          item,
          columnStart: columnWindow.start,
          columnEnd: columnWindow.end,
        },
      ];
    });
  }, [cardSpatialIndex, layout.items, viewport]);

  const visibleRelations = useMemo(
    () =>
      getDiagramSpatialCandidates(
        relationSpatialIndex,
        viewport,
        DIAGRAM_VIEWPORT_OVERSCAN
      ).flatMap((index) => {
        const item = relationRenderItems[index];
        if (
          !item ||
          !item.geometry.segments.some((segment) =>
            isDiagramRectVisible(segment, viewport)
          )
        ) {
          return [];
        }
        return [item];
      }),
    [relationRenderItems, relationSpatialIndex, viewport]
  );

  const hoveredRelation =
    hoveredRelIndex !== null ? state.relations[hoveredRelIndex] : null;

  const isRelationActive = useCallback(
    (relation: DiagramRelation, index: number) =>
      hoveredRelIndex === index ||
      (!!hoveredTableKey &&
        (hoveredTableKey === relation.fromTable ||
          hoveredTableKey === relation.toTable)),
    [hoveredRelIndex, hoveredTableKey]
  );

  const highlightedTableKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!hoveredRelation) return keys;
    keys.add(hoveredRelation.fromTable);
    keys.add(hoveredRelation.toTable);
    return keys;
  }, [hoveredRelation]);

  const idleRelationPath = useMemo(() => {
    const parts: string[] = [];
    for (const item of visibleRelations) {
      if (isRelationActive(item.relation, item.index)) continue;
      parts.push(item.geometry.path);
    }
    return parts.join(" ");
  }, [isRelationActive, visibleRelations]);

  const activeRelations = useMemo(
    () =>
      visibleRelations.filter(({ relation, index }) =>
        isRelationActive(relation, index)
      ),
    [isRelationActive, visibleRelations]
  );

  const surface = getDiagramSurfaceSize(
    layout.width,
    layout.height,
    viewport.width,
    viewport.height
  );
  const scaledW = surface.width * zoom;
  const scaledH = surface.height * zoom;
  const contentMinW = `max(100%, ${scaledW}px)`;
  const contentMinH = `max(100%, ${scaledH}px)`;

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <div class="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <h2 class="space-x-2 text-xs font-semibold text-slate-600">
          <span class="rounded-lg border border-slate-200 px-2 py-1.5">
            {database}
            {schema ? `:${schema}` : ""}
          </span>
          <span class="rounded-lg border border-slate-200 px-2 py-1.5">
            {state.tableCount} tables
          </span>
          <span class="rounded-lg border border-slate-200 px-2 py-1.5">
            {state.relationshipCount} relationships
          </span>
        </h2>

        <div class="flex items-center gap-2">
          {loadDiagram ? (
            <Button
              variant="ghost"
              onClick={loadDiagram}
              class="p-1.5 hover:bg-slate-100"
              title="Refresh"
              aria-label="Refresh diagram"
            >
              <RefreshCwIcon className="size-4.5" />
            </Button>
          ) : null}
          <Dropdown
            open={exportMenuOpen}
            onOpenChange={setExportMenuOpen}
            positions={["bottom"]}
            align="end"
            widthClassName="w-36"
            items={[
              {
                key: "png",
                label: "PNG",
                onSelect: () => void exportPng(),
              },
              {
                key: "json",
                label: "JSON",
                onSelect: () => void exportJson(),
              },
              {
                key: "svg",
                label: "SVG",
                rightSlot: <ProBadge />,
                onSelect: () => void exportSvg(),
              },
            ]}
            trigger={
              // The popover anchors to a DOM element; Button does not forward refs.
              <div>
                <Button
                  variant="ghost"
                  class="p-1.5 hover:bg-slate-100"
                  title="Export as..."
                  aria-label="Export as..."
                  onClick={() => setExportMenuOpen((open) => !open)}
                >
                  <DownloadIcon className="size-4.5" />
                </Button>
              </div>
            }
          />
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
      </div>

      <div class="relative flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <div ref={scrollRef} class="no-scrollbar min-h-0 flex-1 overflow-auto">
          <div
            class="inline-block min-h-full min-w-full align-top"
            style={{
              width: contentMinW,
              height: contentMinH,
            }}
          >
            <div
              class="relative shrink-0 overflow-hidden"
              style={{ width: `${scaledW}px`, height: `${scaledH}px` }}
            >
              <div
                class={`diagram-surface absolute top-0 left-0 antialiased ${USE_CSS_ZOOM ? "" : "origin-top-left"}`}
                style={
                  {
                    width: `${surface.width}px`,
                    height: `${surface.height}px`,
                    ...(USE_CSS_ZOOM
                      ? { zoom }
                      : {
                          transform: `translate3d(0,0,0) scale(${zoom})`,
                        }),
                  } as Record<string, string | number>
                }
                onMouseOver={(e) => {
                  const key = diagramTableKeyFromTarget(e.target);
                  if (key)
                    setHoveredTableKey((current) =>
                      current === key ? current : key
                    );
                }}
                onMouseOut={(e) => {
                  const fromKey = diagramTableKeyFromTarget(e.target);
                  if (!fromKey) return;
                  const toKey = diagramTableKeyFromTarget(e.relatedTarget);
                  if (toKey === fromKey) return;
                  setHoveredTableKey((current) => {
                    if (toKey) return toKey;
                    return current === fromKey ? null : current;
                  });
                }}
              >
                {visibleCards.map(({ item, columnStart, columnEnd }) => (
                  <DiagramTableCard
                    key={item.key}
                    item={item}
                    highlighted={highlightedTableKeys.has(item.key)}
                    columnStart={columnStart}
                    columnEnd={columnEnd}
                  />
                ))}
                <svg
                  class="pointer-events-none absolute z-100 overflow-hidden"
                  style={{ left: `${svgBox.x}px`, top: `${svgBox.y}px` }}
                  width={svgBox.width}
                  height={svgBox.height}
                  viewBox={`${svgBox.x} ${svgBox.y} ${svgBox.width} ${svgBox.height}`}
                >
                  <defs>
                    <mask id="diagram-rel-mask" maskUnits="userSpaceOnUse">
                      <rect
                        x={svgBox.x}
                        y={svgBox.y}
                        width={svgBox.width}
                        height={svgBox.height}
                        fill="white"
                      />
                      {visibleCards.map(({ item }) => (
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
                  {showDetails
                    ? visibleRelations.map(
                        ({ relation, index, geometry: g }) => {
                          const tip = relationHoverTitle(relation);
                          const gk = `${relation.fromTable}-${relation.toTable}-${index}`;
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
                                  onMouseEnter={() =>
                                    onRelationHoverEnter(index)
                                  }
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
                                  onMouseEnter={() =>
                                    onRelationHoverEnter(index)
                                  }
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
                                  onMouseEnter={() =>
                                    onRelationHoverEnter(index)
                                  }
                                  onMouseLeave={onRelationHoverLeave}
                                >
                                  <title>{tip}</title>
                                </circle>
                              </g>
                            );
                          }
                          const tick = oneToManyParentTickGeometry(g);
                          const crow = crowFootLines(
                            g.endX,
                            g.endY,
                            g.enterFrom
                          );
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
                                  onMouseEnter={() =>
                                    onRelationHoverEnter(index)
                                  }
                                  onMouseLeave={onRelationHoverLeave}
                                />
                              ))}
                            </g>
                          );
                        }
                      )
                    : null}
                  <g mask="url(#diagram-rel-mask)">
                    {idleRelationPath ? (
                      <path
                        d={idleRelationPath}
                        fill="none"
                        class={REL_IDLE_CLASS}
                        stroke-width={REL_STROKE_WIDTH}
                        style={{ pointerEvents: "none" }}
                      />
                    ) : null}
                    {showDetails
                      ? visibleRelations.map(
                          ({ relation, index, geometry: g }) => {
                            if (isRelationActive(relation, index)) return null;
                            const gk = `${relation.fromTable}-${relation.toTable}-${index}-marks`;
                            if (relation.cardinality === "one-to-one") {
                              const o = oneToOneCircleCenters(g);
                              return (
                                <g key={gk} class={REL_IDLE_CLASS}>
                                  <circle
                                    cx={o.startCx}
                                    cy={o.startCy}
                                    r={O_MARK_R}
                                    fill="none"
                                    stroke-width={REL_STROKE_WIDTH}
                                    style={{ pointerEvents: "none" }}
                                  />
                                  <circle
                                    cx={o.endCx}
                                    cy={o.endCy}
                                    r={O_MARK_R}
                                    fill="none"
                                    stroke-width={REL_STROKE_WIDTH}
                                    style={{ pointerEvents: "none" }}
                                  />
                                </g>
                              );
                            }
                            const tick = oneToManyParentTickGeometry(g);
                            const crow = crowFootLines(
                              g.endX,
                              g.endY,
                              g.enterFrom
                            );
                            return (
                              <g key={gk} class={REL_IDLE_CLASS}>
                                <line
                                  x1={tick.x}
                                  y1={tick.y1}
                                  x2={tick.x}
                                  y2={tick.y2}
                                  stroke-width={REL_STROKE_WIDTH}
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
                                    stroke-width={REL_STROKE_WIDTH}
                                    stroke-linecap="round"
                                    style={{ pointerEvents: "none" }}
                                  />
                                ))}
                              </g>
                            );
                          }
                        )
                      : null}
                    {activeRelations.map(({ relation, index, geometry: g }) => {
                      const gk = `${relation.fromTable}-${relation.toTable}-${index}-active`;
                      if (relation.cardinality === "one-to-one") {
                        const o = oneToOneCircleCenters(g);
                        return (
                          <g key={gk} class={REL_ACTIVE_CLASS}>
                            <path
                              d={g.path}
                              fill="none"
                              stroke-width={REL_STROKE_HOVER}
                              style={{ pointerEvents: "none" }}
                            />
                            <path
                              d={g.path}
                              fill="none"
                              stroke-width={2}
                              class={REL_FLOW_CLASS}
                              style={{ pointerEvents: "none" }}
                            />
                            <path
                              d={g.path}
                              fill="none"
                              class={REL_FLOW_PARTICLE_CLASS}
                              style={{ pointerEvents: "none" }}
                            />
                            <circle
                              cx={o.startCx}
                              cy={o.startCy}
                              r={O_MARK_R}
                              fill="none"
                              stroke-width={REL_STROKE_HOVER}
                              style={{ pointerEvents: "none" }}
                            />
                            <circle
                              cx={o.endCx}
                              cy={o.endCy}
                              r={O_MARK_R}
                              fill="none"
                              stroke-width={REL_STROKE_HOVER}
                              style={{ pointerEvents: "none" }}
                            />
                          </g>
                        );
                      }
                      const tick = oneToManyParentTickGeometry(g);
                      const crow = crowFootLines(g.endX, g.endY, g.enterFrom);
                      return (
                        <g key={gk} class={REL_ACTIVE_CLASS}>
                          <path
                            d={g.path}
                            fill="none"
                            stroke-width={REL_STROKE_HOVER}
                            style={{ pointerEvents: "none" }}
                          />
                          <path
                            d={g.path}
                            fill="none"
                            stroke-width={2.1}
                            class={REL_FLOW_CLASS}
                            style={{ pointerEvents: "none" }}
                          />
                          <path
                            d={g.path}
                            fill="none"
                            class={REL_FLOW_PARTICLE_CLASS}
                            style={{ pointerEvents: "none" }}
                          />
                          <line
                            x1={tick.x}
                            y1={tick.y1}
                            x2={tick.x}
                            y2={tick.y2}
                            stroke-width={REL_STROKE_HOVER}
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
                              stroke-width={REL_STROKE_HOVER}
                              stroke-linecap="round"
                              style={{ pointerEvents: "none" }}
                            />
                          ))}
                        </g>
                      );
                    })}
                  </g>
                </svg>
              </div>
            </div>
          </div>
        </div>
        <OverlayScrollbars scrollerRef={scrollRef} horizontal vertical />
      </div>
    </div>
  );
}
