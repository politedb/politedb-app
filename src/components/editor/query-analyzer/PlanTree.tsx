import { useEffect, useMemo, useRef } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { ChevronLeftIcon, ChevronRightIcon } from "src/components/icons";
import { heatLevel } from "src/lib/query-analyzer/details";
import {
  formatPlanNumber,
  planNumber,
  type PlanHeat,
  type QueryPlan,
} from "src/lib/query-analyzer/plan";
import { cn } from "src/utils/cn";

export const PLAN_PAGE_SIZE = 100;

const HEAT_BAR: Record<ReturnType<typeof heatLevel>, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-yellow-400",
  none: "bg-neutral-300 dark:bg-neutral-600",
};

export type PlanOrder = "plan" | "hot";

function shareLabel(share: number) {
  if (share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}

/** Rows to show: plan order with collapsed branches hidden, or hottest first. */
export function visiblePlanRows(
  plan: QueryPlan,
  heat: PlanHeat,
  options: { order: PlanOrder; query: string; collapsed: Set<number> }
): number[] {
  const query = options.query.trim().toLowerCase();
  if (query) {
    return plan.nodes
      .filter((node) => node.label.toLowerCase().includes(query))
      .map((node) => node.id);
  }
  if (options.order === "hot") {
    return plan.nodes
      .map((node) => node.id)
      .sort(
        (a, b) =>
          (heat.nodes[b]?.selfShare ?? 0) - (heat.nodes[a]?.selfShare ?? 0) ||
          a - b
      );
  }
  const rows: number[] = [];
  let hiddenBelow: number | null = null;
  for (const node of plan.nodes) {
    if (hiddenBelow !== null) {
      if (node.depth > hiddenBelow) continue;
      hiddenBelow = null;
    }
    rows.push(node.id);
    if (options.collapsed.has(node.id)) hiddenBelow = node.depth;
  }
  return rows;
}

export function Pagination(props: {
  page: number;
  count: number;
  onChange: (page: number) => void;
}) {
  const { page, count } = props;
  if (count <= PLAN_PAGE_SIZE) return null;
  return (
    <div class="flex items-center justify-center gap-2 py-2 text-xs text-neutral-500">
      <Button
        variant="ghost"
        className="h-7 w-7 p-0"
        disabled={page === 0}
        onClick={() => props.onChange(page - 1)}
        title="Previous page"
        aria-label="Previous page"
      >
        <ChevronLeftIcon className="size-4" />
      </Button>
      <span>
        {page * PLAN_PAGE_SIZE + 1}-
        {Math.min((page + 1) * PLAN_PAGE_SIZE, count)} of {count}
      </span>
      <Button
        variant="ghost"
        className="h-7 w-7 p-0"
        disabled={(page + 1) * PLAN_PAGE_SIZE >= count}
        onClick={() => props.onChange(page + 1)}
        title="Next page"
        aria-label="Next page"
      >
        <ChevronRightIcon className="size-4" />
      </Button>
    </div>
  );
}

/**
 * Plan nodes as an indented tree with guide lines. Each row shows the node's
 * own share of the plan (time when measured, cost when estimated); the
 * hottest node is marked. Up/Down move, Left/Right collapse and expand.
 */
export function PlanTree(props: {
  plan: QueryPlan;
  heat: PlanHeat;
  rows: number[];
  selected: number;
  onSelect: (id: number) => void;
  collapsed: Set<number>;
  onToggle: (id: number) => void;
  /** Tree guides and collapsing only make sense in plan order. */
  treeMode: boolean;
  page: number;
  onPageChange: (page: number) => void;
  /**
   * Move keyboard focus to this node once its page is mounted (e.g. after
   * jumping from a recommendation). A new `nonce` repeats the request.
   */
  focusRequest?: { id: number; nonce: number } | null;
  /** Called once the requested focus happened, so it is never replayed. */
  onFocusRequestHandled?: () => void;
}) {
  const { plan, heat, rows, selected, treeMode } = props;
  // In a one-node plan every share is 100%: show nothing rather than noise.
  const showShares = plan.nodes.length > 1;
  const listRef = useRef<HTMLDivElement>(null);
  const hasChildren = useMemo(
    () =>
      plan.nodes.map(
        (node, id) => (plan.nodes[id + 1]?.depth ?? -1) > node.depth
      ),
    [plan]
  );
  const pageRows = rows.slice(
    props.page * PLAN_PAGE_SIZE,
    (props.page + 1) * PLAN_PAGE_SIZE
  );

  // Exactly one row is tabbable: the selected one when it is on this page,
  // otherwise the first row, so the list can always be entered with Tab.
  const tabbableId = pageRows.includes(selected) ? selected : pageRows[0];

  // Focus moves after the page holding the target has rendered.
  const pendingFocus = useRef<number | null>(null);
  const handledRequest = useRef<number | null>(null);
  const request = props.focusRequest;
  if (request && handledRequest.current !== request.nonce) {
    handledRequest.current = request.nonce;
    pendingFocus.current = request.id;
  }
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-node-id="${id}"]`
    );
    if (el) {
      pendingFocus.current = null;
      el.focus();
      if (props.focusRequest?.id === id) props.onFocusRequestHandled?.();
    }
  });

  const focusRow = (id: number) => {
    const index = rows.indexOf(id);
    if (index < 0) return;
    const page = Math.floor(index / PLAN_PAGE_SIZE);
    if (page !== props.page) props.onPageChange(page);
    props.onSelect(id);
    pendingFocus.current = id;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Navigate from the focused row, which may differ from the selection.
    const focused = (event.target as HTMLElement | null)?.closest?.(
      "[data-node-id]"
    );
    const currentId = focused
      ? Number(focused.getAttribute("data-node-id"))
      : selected;
    const index = rows.indexOf(currentId);
    const node = plan.nodes[currentId];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (index < rows.length - 1) focusRow(rows[index + 1]!);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (index > 0) focusRow(rows[index - 1]!);
        return;
      case "Home":
        event.preventDefault();
        if (rows.length) focusRow(rows[0]!);
        return;
      case "End":
        event.preventDefault();
        if (rows.length) focusRow(rows[rows.length - 1]!);
        return;
      case "ArrowRight":
        if (treeMode && node && props.collapsed.has(node.id)) {
          event.preventDefault();
          props.onToggle(node.id);
        }
        return;
      case "ArrowLeft":
        if (
          treeMode &&
          node &&
          hasChildren[node.id] &&
          !props.collapsed.has(node.id)
        ) {
          event.preventDefault();
          props.onToggle(node.id);
        }
        return;
    }
  };

  return (
    <div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Plan nodes"
        class="flex flex-col gap-0.5"
        onKeyDown={onKeyDown}
      >
        {pageRows.map((id) => {
          const node = plan.nodes[id]!;
          const nodeHeat = heat.nodes[id]!;
          const level = heatLevel(nodeHeat.selfShare);
          const isSelected = id === selected;
          const cost = planNumber(node.data, "Total Cost");
          const rowsEstimate = planNumber(node.data, "Plan Rows");
          const actualRows = planNumber(node.data, "Actual Rows");
          const loops = planNumber(node.data, "Actual Loops");
          const secondary = [
            plan.actual && nodeHeat.inclusive !== undefined
              ? `${formatPlanNumber(Math.round(nodeHeat.inclusive * 1000) / 1000, " ms")} total`
              : cost !== undefined
                ? `cost ${formatPlanNumber(cost)}`
                : null,
            actualRows !== undefined
              ? `${formatPlanNumber(actualRows)} rows${rowsEstimate !== undefined ? ` (est. ${formatPlanNumber(rowsEstimate)})` : ""}`
              : rowsEstimate !== undefined
                ? `${formatPlanNumber(rowsEstimate)} rows`
                : null,
            loops !== undefined && loops > 1
              ? `${formatPlanNumber(loops)} loops`
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const depth = treeMode ? Math.min(node.depth, 12) : 0;
          return (
            <div key={id} class="flex items-stretch">
              {Array.from({ length: depth }, (_, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  class="w-4 shrink-0 border-l border-neutral-200 dark:border-neutral-700"
                />
              ))}
              {treeMode && hasChildren[id] ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={
                    props.collapsed.has(id)
                      ? "Expand branch"
                      : "Collapse branch"
                  }
                  onClick={() => props.onToggle(id)}
                  class="flex w-5 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-700"
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 transition-transform",
                      !props.collapsed.has(id) && "rotate-90"
                    )}
                  />
                </button>
              ) : (
                <span class="w-5 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                data-node-id={id}
                tabIndex={id === tabbableId ? 0 : -1}
                onClick={() => props.onSelect(id)}
                class={cn(
                  "my-0.5 flex min-w-0 flex-1 items-center gap-3 rounded-md border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                  isSelected
                    ? "border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/50"
                    : "border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                )}
              >
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2">
                    <span class="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {node.label}
                    </span>
                    {heat.hottestId === id && showShares ? (
                      <span class="shrink-0 rounded bg-red-50 px-1.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-200">
                        Hottest
                      </span>
                    ) : null}
                  </span>
                  {secondary ? (
                    <span class="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {secondary}
                    </span>
                  ) : null}
                </span>
                {showShares ? (
                  <span
                    class="flex w-24 shrink-0 flex-col items-end gap-1"
                    title={
                      heat.kind === "time"
                        ? "This node's own time, as a share of the whole query"
                        : "This node's own estimated cost, as a share of the plan"
                    }
                  >
                    <span class="text-xs text-neutral-600 tabular-nums dark:text-neutral-300">
                      {nodeHeat.attribution === "shared"
                        ? "—"
                        : shareLabel(nodeHeat.selfShare)}
                    </span>
                    <span class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                      <span
                        class={cn("block h-full rounded-full", HEAT_BAR[level])}
                        style={{
                          width: `${Math.max(nodeHeat.selfShare * 100, nodeHeat.selfShare > 0 ? 2 : 0)}%`,
                        }}
                      />
                    </span>
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
        {!rows.length ? (
          <p class="py-6 text-center text-sm text-neutral-500">
            No matching nodes.
          </p>
        ) : null}
      </div>
      <Pagination
        page={props.page}
        count={rows.length}
        onChange={props.onPageChange}
      />
    </div>
  );
}
