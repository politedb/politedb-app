import { formatPlanNumber, planMetrics, type QueryPlan } from "./plan";
import { analyzeQueryPlan } from "./findings";

export function queryPlanReport(plan: QueryPlan): string {
  return [
    "# PoliteDB Query Analysis",
    "",
    plan.actual ? "Measured plan" : "Estimated plan (not execution timing)",
    "",
    ...planMetrics(plan)
      .filter(([, value]) => value !== undefined)
      .map(
        ([label, value, unit]) => `- ${label}: ${formatPlanNumber(value, unit)}`
      ),
    "",
    "## Review findings",
    "",
    ...analyzeQueryPlan(plan).map(
      (f) => `- Node ${f.nodeId + 1}: ${f.title}. ${f.detail}`
    ),
    "",
    "Heuristic findings are not proof of a performance problem. Costs are planner units, not milliseconds. Parent metrics include children; do not sum them. Node actual rows and times are per-loop averages. Parallel worker times overlap.",
    "",
    "## Plan",
    "",
    "Plan may contain private relation names, expressions and literal values.",
    "",
    "```json",
    JSON.stringify([plan.document], null, 2),
    "```",
    "",
  ].join("\n");
}
