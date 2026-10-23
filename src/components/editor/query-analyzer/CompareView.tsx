import { comparePlans } from "src/lib/query-analyzer/details";
import { parseImportedPlan } from "src/lib/query-analyzer/fromResult";
import {
  MAX_PLAN_BYTES,
  formatPlanNumber,
  planMetrics,
  type QueryPlan,
} from "src/lib/query-analyzer/plan";
import { cn } from "src/utils/cn";

/** An earlier plan from this editor tab that can be used as the baseline. */
export type BaselineOption = {
  id: string;
  title: string;
  load: () => QueryPlan | null;
};

/** The chosen baseline; owned by the analyzer so it survives view changes. */
export type Comparison = {
  plan: QueryPlan | null;
  name: string;
  selectedId: string;
};

function changeLabel(change: number | undefined) {
  if (change === undefined) return "—";
  if (Math.abs(change) < 0.005) return "No change";
  const sign = change > 0 ? "+" : "−";
  return `${sign}${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%`;
}

/**
 * Compare this plan with an earlier Explain from the same tab, or with a
 * PostgreSQL JSON plan file. Lower is better for every figure shown.
 */
export function CompareView(props: {
  plan: QueryPlan;
  baselines: BaselineOption[];
  comparison: Comparison | null;
  onComparisonChange: (next: Comparison | null) => void;
  /**
   * Owned by the analyzer: bumped by every pick or import, so a file read
   * finishing later (even after a view switch) knows whether it is current.
   */
  importCounter: { value: number };
  onMessage: (message: string) => void;
}) {
  const { plan, baselines } = props;
  const baseline = props.comparison?.plan ?? null;
  const baselineName = props.comparison?.name ?? "";
  const selectedId = props.comparison?.selectedId ?? "";
  const { importCounter } = props;

  const pickRun = (id: string) => {
    importCounter.value += 1;
    props.onMessage("");
    const option = baselines.find((item) => item.id === id);
    const loaded = option?.load() ?? null;
    props.onComparisonChange(
      option ? { plan: loaded, name: option.title, selectedId: id } : null
    );
    if (option && !loaded) {
      props.onMessage("That result is no longer available as a plan.");
    }
  };

  async function importBaseline(file: File | undefined) {
    const version = ++importCounter.value;
    props.onComparisonChange(null);
    props.onMessage("");
    if (!file) return;
    if (file.size > MAX_PLAN_BYTES) {
      props.onMessage("Plan exceeds the 5 MB limit.");
      return;
    }
    try {
      const parsed = parseImportedPlan(await file.text());
      if (version !== importCounter.value) return;
      if (!parsed) {
        props.onMessage(
          "Invalid PostgreSQL JSON plan, or more than 5,000 plan nodes."
        );
        return;
      }
      props.onComparisonChange({
        plan: parsed,
        name: file.name || "Imported plan",
        selectedId: "",
      });
    } catch {
      if (version === importCounter.value)
        props.onMessage("Could not read the plan file.");
    }
  }

  const rows = baseline ? comparePlans(plan, baseline, planMetrics) : [];

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-3 text-sm">
        {baselines.length ? (
          <label class="flex items-center gap-2">
            <span class="text-neutral-600 dark:text-neutral-300">
              Compare with
            </span>
            <select
              value={selectedId}
              onInput={(e) => pickRun(e.currentTarget.value)}
              class="h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            >
              <option value="">Choose an earlier Explain…</option>
              {baselines.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label class="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
          {baselines.length ? "or import" : "Import a baseline"}
          <input
            aria-label="Baseline JSON plan"
            type="file"
            accept=".json,application/json"
            class="max-w-full text-xs"
            onInput={(event) => {
              void importBaseline(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>

      {!baseline ? (
        <p class="text-sm text-neutral-500 dark:text-neutral-400">
          Pick an earlier Explain from this tab, or import a PostgreSQL JSON
          plan, to see the figures side by side.
        </p>
      ) : (
        <>
          <div class="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
            <table class="w-full table-fixed border-collapse text-sm">
              <thead class="bg-neutral-50 text-left text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
                <tr>
                  <th class="p-2 font-medium">Metric</th>
                  <th class="p-2 font-medium">Baseline</th>
                  <th class="p-2 font-medium">Current</th>
                  <th class="p-2 font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.label}
                    class="border-t border-neutral-200 dark:border-neutral-700"
                  >
                    <td class="p-2">{row.label}</td>
                    <td class="p-2 tabular-nums">
                      {formatPlanNumber(row.baseline, row.unit)}
                    </td>
                    <td class="p-2 tabular-nums">
                      {formatPlanNumber(row.current, row.unit)}
                    </td>
                    <td
                      class={cn(
                        "p-2 font-medium tabular-nums",
                        row.change === undefined || Math.abs(row.change) < 0.005
                          ? "text-neutral-500"
                          : row.change < 0
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-red-700 dark:text-red-300"
                      )}
                    >
                      {changeLabel(row.change)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="text-xs text-neutral-500 dark:text-neutral-400">
            Baseline ({baselineName}):{" "}
            {baseline.actual ? "measured" : "estimated"}. Current:{" "}
            {plan.actual ? "measured" : "estimated"}. Lower is better. Query
            text, parameters, server settings and cache state are not compared,
            so a difference alone does not prove an improvement.
          </p>
        </>
      )}
    </div>
  );
}
