import { useMemo, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { InfoHint } from "src/components/common/InfoHint";
import { ProBadge } from "src/components/license/ProBadge";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import {
  CopyCheckIcon,
  CopyIcon,
  DownloadIcon,
  SearchIcon,
} from "src/components/icons";
import { useProGate } from "src/hooks/useProGate";
import { saveDialog, confirmDialog } from "src/lib/system-dialog";
import { writeTextFile } from "src/lib/system-fs";
import { analyzeQueryPlan } from "src/lib/query-analyzer/findings";
import { queryPlanReport } from "src/lib/query-analyzer/report";
import {
  formatPlanNumber,
  planHeat,
  planMetrics,
  type QueryPlan,
} from "src/lib/query-analyzer/plan";
import { cn } from "src/utils/cn";
import {
  CompareView,
  type BaselineOption,
  type Comparison,
} from "./CompareView";
import { NodeDetails } from "./NodeDetails";
import {
  PLAN_PAGE_SIZE,
  Pagination,
  PlanTree,
  visiblePlanRows,
  type PlanOrder,
} from "./PlanTree";

export type { BaselineOption } from "./CompareView";

const views = ["Plan", "Recommendations", "Compare", "JSON"] as const;
type View = (typeof views)[number];

function pageOf(index: number) {
  return Math.floor(Math.max(0, index) / PLAN_PAGE_SIZE);
}

/** Below this many nodes the filter box is noise. */
const FILTER_MIN_NODES = 10;

function JsonView(props: { plan: QueryPlan }) {
  const [copied, setCopied] = useState(false);
  // Up to 5 MB: stringify once per plan, not on every render.
  const text = useMemo(
    () => JSON.stringify([props.plan.document], null, 2),
    [props.plan]
  );
  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between text-xs text-neutral-500">
        <span>{formatPlanNumber(text.length)} characters</span>
        <Button
          type="button"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1000);
            } catch {
              // Clipboard can be unavailable.
            }
          }}
        >
          {copied ? (
            <CopyCheckIcon className="size-3.5 text-green-700" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy JSON"}
        </Button>
      </div>
      <pre class="rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap dark:border-neutral-700 dark:bg-neutral-900">
        {text}
      </pre>
    </div>
  );
}

export function QueryAnalyzer(props: {
  plan: QueryPlan;
  /** Earlier Explain results from this tab, for Compare. */
  baselines?: BaselineOption[];
  /** Re-run the statement with EXPLAIN ANALYZE, when available. */
  onRunAnalyze?: () => void;
}) {
  const { plan } = props;
  const [view, setView] = useState<View>("Plan");
  const heat = useMemo(() => planHeat(plan), [plan]);
  const [selected, setSelected] = useState(() => heat.hottestId ?? 0);
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<PlanOrder>("plan");
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  // Open on the page that holds the initially selected (hottest) node.
  const [page, setPage] = useState(() => pageOf(heat.hottestId ?? 0));
  const [findingsPage, setFindingsPage] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{
    id: number;
    nonce: number;
  } | null>(null);
  // Monotonic across cleared requests, so a repeat reveal is always new.
  const focusNonce = useRef(0);
  // Comparison survives switching views; it belongs to this plan.
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const importCounter = useRef({ value: 0 }).current;
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const { requirePro } = useProGate();
  const findings = useMemo(() => analyzeQueryPlan(plan), [plan]);
  const rows = useMemo(
    () => visiblePlanRows(plan, heat, { order, query: search, collapsed }),
    [plan, heat, order, search, collapsed]
  );
  const node = plan.nodes[selected] ?? plan.nodes[0]!;
  const metrics = planMetrics(plan).filter(([, value]) => value !== undefined);
  const hottest = heat.hottestId !== null ? plan.nodes[heat.hottestId] : null;
  const treeMode = order === "plan" && !search.trim();

  const select = (id: number) => {
    setSelected(id);
    const index = rows.indexOf(id);
    if (index >= 0) setPage(Math.floor(index / PLAN_PAGE_SIZE));
  };

  const revealInPlan = (id: number) => {
    // Expand every collapsed ancestor so the node is visible.
    const nextCollapsed = new Set(collapsed);
    const target = plan.nodes[id]!;
    for (let i = id - 1, depth = target.depth; i >= 0 && depth > 0; i--) {
      const candidate = plan.nodes[i]!;
      if (candidate.depth < depth) {
        nextCollapsed.delete(candidate.id);
        depth = candidate.depth;
      }
    }
    const nextRows = visiblePlanRows(plan, heat, {
      order: "plan",
      query: "",
      collapsed: nextCollapsed,
    });
    setSearch("");
    setOrder("plan");
    setCollapsed(nextCollapsed);
    setSelected(id);
    setPage(pageOf(nextRows.indexOf(id)));
    setView("Plan");
    // The shortcut that was focused is going away; land on the node.
    focusNonce.current += 1;
    setFocusRequest({ id, nonce: focusNonce.current });
  };

  const toggle = (id: number) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function exportPlan(format: "json" | "md") {
    // Report exports are Pro; checked before any export work or dialog.
    if (!requirePro("query-analyzer")) return;
    setSaving(true);
    setMessage("");
    try {
      if (
        !(await confirmDialog(
          "The exported plan may contain private database identifiers and literal values. Save it locally?",
          { title: "Export query analysis", kind: "warning" }
        ))
      )
        return;
      const path = await saveDialog({
        defaultPath: `query-analysis.${format}`,
        filters: [
          {
            name: format === "json" ? "JSON plan" : "Markdown report",
            extensions: [format],
          },
        ],
      });
      if (!path) return;
      await writeTextFile(
        path,
        format === "json"
          ? JSON.stringify([plan.document], null, 2)
          : queryPlanReport(plan)
      );
      setMessage("Export complete.");
    } catch {
      setMessage("Export failed. Check file permissions and try again.");
    } finally {
      setSaving(false);
    }
  }

  const estimatedHint = [
    "Costs are planner units, not milliseconds; parent costs include their children.",
    "Actual time, actual rows and buffer I/O appear only in a measured plan.",
    plan.analyzeHint
      ? `To measure, run ${plan.analyzeHint}. That executes the statement.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const measuredHint =
    "Parent timings and buffers include their children; the shares here subtract them. Actual rows and times are per-loop averages (totals multiply by loops). Parallel worker timings overlap.";

  return (
    <div class="flex h-full min-h-0 min-w-0 flex-col bg-white text-sm text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div class="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <strong class="font-semibold">Query Analyzer</strong>
        <ProBadge />
        <span
          class={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            plan.actual
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          )}
        >
          {plan.actual ? "Measured plan" : "Estimated plan"}
        </span>
        <div class="ml-auto flex gap-1">
          <Button
            variant="ghost"
            className="h-8 gap-1.5 px-2"
            loading={saving}
            onClick={() => void exportPlan("md")}
            title="Export Markdown report"
          >
            <DownloadIcon className="size-4" />
            Report
          </Button>
          <Button
            variant="ghost"
            className="h-8 gap-1.5 px-2"
            disabled={saving}
            onClick={() => void exportPlan("json")}
            title="Export JSON plan"
          >
            <DownloadIcon className="size-4" />
            JSON
          </Button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Query analysis views"
        onKeyDown={(event) => {
          const index = views.indexOf(view);
          const next =
            event.key === "ArrowRight"
              ? views[(index + 1) % views.length]
              : event.key === "ArrowLeft"
                ? views[(index - 1 + views.length) % views.length]
                : event.key === "Home"
                  ? views[0]
                  : event.key === "End"
                    ? views[views.length - 1]
                    : null;
          if (!next) return;
          event.preventDefault();
          setView(next);
          (event.currentTarget as HTMLElement)
            .querySelector<HTMLButtonElement>(`#qa-tab-${next}`)
            ?.focus();
        }}
        class="flex gap-4 border-b border-neutral-200 px-3 dark:border-neutral-800"
      >
        {views.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view === tab}
            tabIndex={view === tab ? 0 : -1}
            id={`qa-tab-${tab}`}
            aria-controls="qa-panel"
            onClick={() => setView(tab)}
            class={cn(
              "-mb-px border-b-2 py-2 text-sm font-medium transition-colors",
              view === tab
                ? "border-blue-500 text-blue-600 dark:text-blue-300"
                : "border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            )}
          >
            {tab}
            {tab === "Recommendations" ? ` (${findings.length})` : ""}
          </button>
        ))}
      </div>

      <OverlayScrollArea
        className="min-h-0 flex-1"
        contentClassName="space-y-4 p-3"
        vertical
      >
        <div
          id="qa-panel"
          role="tabpanel"
          aria-labelledby={`qa-tab-${view}`}
          class="space-y-4"
        >
          <div
            class={cn(
              "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs",
              plan.actual
                ? "border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                : "border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
            )}
          >
            <span>
              {plan.actual
                ? "Measured with EXPLAIN ANALYZE: shares show where the time went."
                : "Estimated by the planner: shares show where it expects the cost, not time."}
            </span>
            <InfoHint text={plan.actual ? measuredHint : estimatedHint} />
            {!plan.actual && props.onRunAnalyze ? (
              <Button
                type="button"
                variant="outline"
                className="ml-auto h-7 px-2 text-xs"
                onClick={props.onRunAnalyze}
              >
                Run with ANALYZE
              </Button>
            ) : null}
          </div>

          <div class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
            {metrics.map(([label, value, unit]) => (
              <div
                key={label}
                class="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-700"
              >
                <div class="text-xs text-neutral-500 dark:text-neutral-400">
                  {label}
                </div>
                <div class="mt-0.5 text-base font-semibold tabular-nums">
                  {formatPlanNumber(value, unit)}
                </div>
              </div>
            ))}
            <div class="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-700">
              <div class="text-xs text-neutral-500 dark:text-neutral-400">
                Plan nodes
              </div>
              <div class="mt-0.5 text-base font-semibold tabular-nums">
                {formatPlanNumber(plan.nodes.length)}
              </div>
            </div>
            {hottest && plan.nodes.length > 1 ? (
              <button
                type="button"
                onClick={() => revealInPlan(hottest.id)}
                class="rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-left hover:bg-red-50 dark:border-red-900 dark:bg-red-950/40"
              >
                <div class="text-xs text-red-700 dark:text-red-300">
                  {heat.kind === "time" ? "Most time" : "Most cost"} ·{" "}
                  {Math.round((heat.nodes[hottest.id]?.selfShare ?? 0) * 100)}%
                </div>
                <div
                  class="mt-0.5 line-clamp-2 font-semibold [overflow-wrap:anywhere]"
                  title={hottest.label}
                >
                  {hottest.label}
                </div>
              </button>
            ) : null}
          </div>

          {view === "Plan" && (
            <>
              <div class="flex flex-wrap items-center gap-2">
                {plan.nodes.length >= FILTER_MIN_NODES ? (
                  <div class="relative w-64 max-w-full">
                    <input
                      type="search"
                      aria-label="Filter plan nodes"
                      placeholder="Filter plan nodes..."
                      value={search}
                      onInput={(event) => {
                        setSearch(event.currentTarget.value);
                        setPage(0);
                      }}
                      class="h-8 w-full rounded-md border border-neutral-300 bg-white py-1 pr-2 pl-8 text-sm outline-none placeholder:text-neutral-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-400" />
                  </div>
                ) : null}
                {plan.nodes.length > 1 ? (
                  <div
                    role="group"
                    aria-label="Node order"
                    class="ml-auto inline-flex rounded-md border border-neutral-300 p-0.5 text-xs dark:border-neutral-700"
                  >
                    {(
                      [
                        ["plan", "Plan order"],
                        [
                          "hot",
                          heat.kind === "time"
                            ? "Slowest first"
                            : "Costliest first",
                        ],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={order === value}
                        onClick={() => {
                          setOrder(value);
                          setPage(0);
                        }}
                        class={cn(
                          "rounded px-2 py-1",
                          order === value
                            ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                            : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,38%)]">
                <PlanTree
                  plan={plan}
                  heat={heat}
                  rows={rows}
                  selected={node.id}
                  onSelect={select}
                  collapsed={collapsed}
                  onToggle={toggle}
                  treeMode={treeMode}
                  page={page}
                  onPageChange={setPage}
                  focusRequest={focusRequest}
                  onFocusRequestHandled={() => setFocusRequest(null)}
                />
                <div class="border-t border-neutral-200 pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4 dark:border-neutral-800">
                  <NodeDetails key={node.id} node={node} heat={heat} />
                </div>
              </div>
            </>
          )}

          {view === "Recommendations" && (
            <div class="space-y-3">
              <p class="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                Heuristic findings, not confirmed bottlenecks.
                <InfoHint text="Validate against representative data and workload before changing indexes or settings." />
              </p>
              {!findings.length ? (
                <p class="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                  {plan.actual
                    ? "No heuristic findings. This does not establish that the query is optimal."
                    : "Nothing stands out in the estimated plan. Most checks need measured numbers (actual rows, time, buffers); run the statement with EXPLAIN ANALYZE to get them."}
                </p>
              ) : null}
              {findings
                .slice(
                  findingsPage * PLAN_PAGE_SIZE,
                  (findingsPage + 1) * PLAN_PAGE_SIZE
                )
                .map((finding, index) => (
                  <section
                    key={`${finding.nodeId}:${index}`}
                    class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
                  >
                    <h3 class="font-semibold">{finding.title}</h3>
                    <p class="mt-1 text-neutral-600 dark:text-neutral-300">
                      {finding.detail}
                    </p>
                    <button
                      type="button"
                      onClick={() => revealInPlan(finding.nodeId)}
                      class="mt-2 text-xs text-blue-600 hover:underline dark:text-blue-300"
                    >
                      Node {finding.nodeId + 1}:{" "}
                      {plan.nodes[finding.nodeId]?.label}
                    </button>
                  </section>
                ))}
              <Pagination
                page={findingsPage}
                count={findings.length}
                onChange={setFindingsPage}
              />
            </div>
          )}

          {view === "Compare" && (
            <CompareView
              plan={plan}
              baselines={props.baselines ?? []}
              comparison={comparison}
              onComparisonChange={setComparison}
              importCounter={importCounter}
              onMessage={setMessage}
            />
          )}

          {view === "JSON" && <JsonView plan={plan} />}
        </div>

        <p
          role="status"
          class={cn(
            "text-xs text-neutral-600 dark:text-neutral-300",
            !message && "sr-only"
          )}
        >
          {message}
        </p>
      </OverlayScrollArea>
    </div>
  );
}
