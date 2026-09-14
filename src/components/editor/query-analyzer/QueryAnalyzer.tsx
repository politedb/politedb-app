import { useMemo, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
} from "src/components/icons";
import { saveDialog, confirmDialog } from "src/lib/system-dialog";
import { writeTextFile } from "src/lib/system-fs";
import { analyzeQueryPlan } from "src/lib/query-analyzer/findings";
import { queryPlanReport } from "src/lib/query-analyzer/report";
import {
  MAX_PLAN_BYTES,
  formatPlanNumber,
  parseQueryPlan,
  planMetrics,
  planNumber,
  type QueryPlan,
} from "src/lib/query-analyzer/plan";
import "./query-analyzer.css";

const PAGE_SIZE = 80;
const views = ["Plan", "Recommendations", "Compare", "JSON"] as const;
type View = (typeof views)[number];

function Pagination({
  page,
  count,
  onChange,
}: {
  page: number;
  count: number;
  onChange: (page: number) => void;
}) {
  if (count <= PAGE_SIZE) return null;
  return (
    <div class="qa-pagination">
      <Button
        variant="ghost"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
        title="Previous page"
        aria-label="Previous page"
      >
        <ChevronLeftIcon className="size-4" />
      </Button>
      <span>
        {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, count)} /{" "}
        {count}
      </span>
      <Button
        variant="ghost"
        disabled={(page + 1) * PAGE_SIZE >= count}
        onClick={() => onChange(page + 1)}
        title="Next page"
        aria-label="Next page"
      >
        <ChevronRightIcon className="size-4" />
      </Button>
    </div>
  );
}

export function QueryAnalyzer({ plan }: { plan: QueryPlan }) {
  const [view, setView] = useState<View>("Plan");
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [baseline, setBaseline] = useState<QueryPlan | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const importVersion = useRef(0);
  const findings = useMemo(() => analyzeQueryPlan(plan), [plan]);
  const filtered = useMemo(
    () =>
      plan.nodes.filter((node) =>
        node.label.toLowerCase().includes(search.toLowerCase())
      ),
    [plan, search]
  );
  const node = plan.nodes[selected] ?? plan.nodes[0];
  const metrics = planMetrics(plan);
  const baselineMetrics = baseline ? planMetrics(baseline) : [];
  const changeView = (next: View) => {
    setView(next);
    setPage(0);
  };

  async function exportPlan(format: "json" | "md") {
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

  async function importBaseline(file: File | undefined) {
    const version = ++importVersion.current;
    setBaseline(null);
    setMessage("");
    if (!file) return;
    if (file.size > MAX_PLAN_BYTES) {
      setMessage("Plan exceeds the 5 MB limit.");
      return;
    }
    try {
      const parsed = parseQueryPlan(await file.text());
      if (version !== importVersion.current) return;
      if (!parsed) {
        setMessage(
          "Invalid PostgreSQL JSON plan, or more than 5,000 plan nodes."
        );
        return;
      }
      setBaseline(parsed);
    } catch {
      if (version === importVersion.current)
        setMessage("Could not read the plan file.");
    }
  }

  return (
    <div class="query-analyzer">
      <div class="qa-toolbar">
        <strong>Query Analyzer</strong>
        <span class="qa-badge">
          {plan.actual ? "Measured plan" : "Estimated plan"}
        </span>
        <div class="qa-actions">
          <Button
            variant="ghost"
            loading={saving}
            onClick={() => void exportPlan("md")}
            title="Export Markdown report"
          >
            <DownloadIcon className="size-4" />
            Report
          </Button>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => void exportPlan("json")}
            title="Export JSON plan"
          >
            <DownloadIcon className="size-4" />
            JSON
          </Button>
        </div>
      </div>
      <div class="qa-views" aria-label="Query analysis views">
        {views.map((tab) => (
          <button
            key={tab}
            type="button"
            aria-pressed={view === tab}
            onClick={() => changeView(tab)}
          >
            {tab}
            {tab === "Recommendations" ? ` (${findings.length})` : ""}
          </button>
        ))}
      </div>
      <OverlayScrollArea
        className="min-h-0 flex-1"
        contentClassName="qa-content"
        vertical
      >
        <div class="qa-metrics">
          {metrics.map(([label, value, unit]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{formatPlanNumber(value, unit)}</strong>
            </div>
          ))}
        </div>
        {!plan.actual && (
          <p class="qa-note">
            Estimates only. Execution time, actual rows and runtime I/O are
            unavailable.
          </p>
        )}
        {view === "Plan" && (
          <>
            <input
              class="qa-search"
              aria-label="Filter plan nodes"
              placeholder="Filter plan nodes..."
              value={search}
              onInput={(event) => {
                setSearch(event.currentTarget.value);
                setPage(0);
              }}
            />
            <div class="qa-plan">
              <div class="qa-nodes">
                {filtered
                  .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
                  .map((item) => {
                    const cost = planNumber(item.data, "Total Cost");
                    const maxCost =
                      planNumber(plan.nodes[0].data, "Total Cost") ?? 0;
                    return (
                      <button
                        key={item.id}
                        class="qa-node"
                        aria-pressed={node.id === item.id}
                        onClick={() => setSelected(item.id)}
                        style={{
                          marginLeft: Math.min(item.depth, 8) * 10,
                          width: `calc(100% - ${Math.min(item.depth, 8) * 10}px)`,
                        }}
                      >
                        <strong>
                          {item.id + 1}. {item.label}
                        </strong>
                        <span>
                          Estimated cost: {formatPlanNumber(cost)} | Rows:{" "}
                          {formatPlanNumber(planNumber(item.data, "Plan Rows"))}
                        </span>
                        {plan.actual && (
                          <span>
                            Actual:{" "}
                            {formatPlanNumber(
                              planNumber(item.data, "Actual Total Time"),
                              " ms / loop"
                            )}{" "}
                            | Loops:{" "}
                            {formatPlanNumber(
                              planNumber(item.data, "Actual Loops")
                            )}
                          </span>
                        )}
                        <span
                          class="qa-track"
                          title="Estimated inclusive cost relative to root"
                        >
                          <span
                            style={{
                              width: `${maxCost > 0 ? Math.min(100, ((cost ?? 0) / maxCost) * 100) : 0}%`,
                            }}
                          />
                        </span>
                      </button>
                    );
                  })}
                {!filtered.length && <p>No matching nodes.</p>}
                <Pagination
                  page={page}
                  count={filtered.length}
                  onChange={setPage}
                />
              </div>
              <section class="qa-details" aria-label="Selected node">
                <h3>{node.label}</h3>
                <dl>
                  {[
                    "Startup Cost",
                    "Total Cost",
                    "Plan Rows",
                    "Actual Startup Time",
                    "Actual Total Time",
                    "Actual Rows",
                    "Actual Loops",
                    "Rows Removed by Filter",
                    "Shared Hit Blocks",
                    "Shared Read Blocks",
                    "Temp Read Blocks",
                    "Temp Written Blocks",
                  ]
                    .filter((key) => planNumber(node.data, key) !== undefined)
                    .map((key) => (
                      <div key={key}>
                        <dt>
                          {key}
                          {key.startsWith("Actual") && key !== "Actual Loops"
                            ? " / loop"
                            : ""}
                        </dt>
                        <dd>
                          {formatPlanNumber(
                            planNumber(node.data, key),
                            key.endsWith("Time") ? " ms" : ""
                          )}
                        </dd>
                      </div>
                    ))}
                </dl>
                {[
                  "Filter",
                  "Index Cond",
                  "Hash Cond",
                  "Join Filter",
                  "Sort Key",
                  "Sort Method",
                  "Sort Space Type",
                  "Workers Planned",
                  "Workers Launched",
                ]
                  .filter((key) => node.data[key] !== undefined)
                  .map((key) => (
                    <div class="qa-expression" key={key}>
                      <span>{key}</span>
                      <pre>
                        {typeof node.data[key] === "string"
                          ? node.data[key]
                          : JSON.stringify(node.data[key])}
                      </pre>
                    </div>
                  ))}
              </section>
            </div>
            <p class="qa-note">
              Costs are planner units, not milliseconds. Parent timings and
              buffers include children; do not sum nodes. Actual rows and times
              are per-loop averages. Parallel worker timings overlap.
            </p>
          </>
        )}
        {view === "Recommendations" && (
          <>
            <p class="qa-note">
              Heuristic findings, not confirmed bottlenecks. Validate against
              representative data and workload before changing indexes or
              settings.
            </p>
            {!findings.length && (
              <p>
                No heuristic findings. This does not establish that the query is
                optimal.
              </p>
            )}
            {findings
              .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
              .map((finding, index) => (
                <section class="qa-finding" key={`${finding.nodeId}:${index}`}>
                  <button
                    onClick={() => {
                      setSelected(finding.nodeId);
                      setSearch("");
                      setPage(Math.floor(finding.nodeId / PAGE_SIZE));
                      setView("Plan");
                    }}
                  >
                    Node {finding.nodeId + 1}:{" "}
                    {plan.nodes[finding.nodeId].label}
                  </button>
                  <h3>{finding.title}</h3>
                  <p>{finding.detail}</p>
                </section>
              ))}
            <Pagination
              page={page}
              count={findings.length}
              onChange={setPage}
            />
          </>
        )}
        {view === "Compare" && (
          <>
            <label class="qa-import">
              Baseline PostgreSQL plan (.json)
              <input
                aria-label="Baseline JSON plan"
                type="file"
                accept=".json,application/json"
                onInput={(event) => {
                  void importBaseline(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {baseline && (
              <>
                <div class="qa-comparison">
                  <table>
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Baseline</th>
                        <th>Current</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.map(([label, value, unit], index) => (
                        <tr key={label}>
                          <td>{label}</td>
                          <td>
                            {formatPlanNumber(baselineMetrics[index][1], unit)}
                          </td>
                          <td>{formatPlanNumber(value, unit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p class="qa-note">
                  Baseline: {baseline.actual ? "measured" : "estimated"}.
                  Current: {plan.actual ? "measured" : "estimated"}. Query
                  identity, parameters, server settings and cache conditions are
                  not verified. These measurements alone do not prove an
                  improvement.
                </p>
              </>
            )}
          </>
        )}
        {view === "JSON" && (
          <pre class="qa-json">{JSON.stringify([plan.document], null, 2)}</pre>
        )}
        <p role="status" class="qa-note">
          {message}
        </p>
      </OverlayScrollArea>
    </div>
  );
}
