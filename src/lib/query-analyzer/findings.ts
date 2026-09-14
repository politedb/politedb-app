import { planNumber, planText, type QueryPlan } from "./plan";

export type PlanFinding = { nodeId: number; title: string; detail: string };

export function analyzeQueryPlan(plan: QueryPlan): PlanFinding[] {
  const findings: PlanFinding[] = [];
  for (const node of plan.nodes) {
    const n = (key: string) => planNumber(node.data, key);
    if (n("Actual Loops") === 0) continue;
    const add = (title: string, detail: string) =>
      findings.push({ nodeId: node.id, title, detail });
    const actual = n("Actual Rows");
    const removed = n("Rows Removed by Filter");
    const seqLike =
      /seq scan|table scan|table access full|^all$|scan table|readfrommergetree/i.test(
        node.type
      );
    if (seqLike && planText(node.data, "Filter")) {
      if (
        removed !== undefined &&
        actual !== undefined &&
        removed >= 1000 &&
        removed > actual * 9
      ) {
        add(
          "Selective filter after sequential scan",
          "More than 90% of scanned rows are discarded. Review an index matching the filter and ordering, existing indexes, and write overhead. A sequential scan is not inherently a problem."
        );
      } else if (!plan.actual) {
        add(
          "Filtered sequential scan",
          "Review filter selectivity and existing indexes. This estimated plan alone cannot establish a bottleneck or justify creating an index."
        );
      }
    }
    const estimated = n("Plan Rows");
    if (
      !node.partial &&
      actual !== undefined &&
      estimated !== undefined &&
      actual >= 100 &&
      Math.max(actual, estimated) / Math.max(1, Math.min(actual, estimated)) >=
        10
    ) {
      add(
        "Row estimate differs by at least 10x",
        "Check statistics freshness, skew, and correlated predicates. Consider ANALYZE on the affected relation, then recheck. Early termination or parameter choices can also explain differences."
      );
    }
    if (planText(node.data, "Sort Space Type") === "Disk") {
      add(
        "Sort spilled to disk",
        "Review rows entering the sort and whether an index can supply the ordering. Consider session-local work_mem only after assessing concurrent sorts and memory capacity."
      );
    }
    if ((n("Hash Batches") ?? 0) > 1) {
      add(
        "Hash operation uses multiple batches",
        "Review build-side row estimates and memory pressure. Avoid globally increasing memory limits without evaluating concurrent queries."
      );
    }
  }
  return findings;
}
