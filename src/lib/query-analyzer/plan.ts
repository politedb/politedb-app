import { cellToString } from "src/utils/convert";

export type PlanRecord = Record<string, unknown>;

export type PlanNode = {
  id: number;
  depth: number;
  type: string;
  label: string;
  partial: boolean;
  data: PlanRecord;
};

export type QueryPlan = {
  document: PlanRecord;
  nodes: PlanNode[];
  actual: boolean;
};

export const MAX_PLAN_BYTES = 5 * 1024 * 1024;
const MAX_PLAN_NODES = 5000;

function record(value: unknown): value is PlanRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedDocument(value: PlanRecord): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let fields = 0;
  let characters = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++fields > 100000 || entry.depth > 128) return false;
    if (typeof entry.value === "string") characters += entry.value.length;
    if (characters > MAX_PLAN_BYTES) return false;
    if (entry.value && typeof entry.value === "object") {
      if (seen.has(entry.value)) return false;
      seen.add(entry.value);
      const values = Object.values(entry.value);
      if (values.length + pending.length + fields > 100000) return false;
      for (const child of values)
        pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return true;
}

export function planNumber(data: PlanRecord, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function planText(data: PlanRecord, key: string): string | undefined {
  return typeof data[key] === "string" ? data[key] : undefined;
}

/** Accept the PostgreSQL JSON document, not arbitrary JSON query results. */
export function parseQueryPlan(value: unknown): QueryPlan | null {
  try {
    if (typeof value === "string") {
      if (value.length > MAX_PLAN_BYTES) return null;
      value = JSON.parse(value);
    }
    const document =
      Array.isArray(value) && value.length === 1 ? value[0] : value;
    if (!record(document) || !record(document.Plan)) return null;
    // Bound untrusted imports, including nested metadata outside the Plans tree.
    if (!boundedDocument(document)) return null;
    const nodes: PlanNode[] = [];
    const seen = new Set<object>();
    const pending = [{ data: document.Plan, depth: 0, partial: false }];
    while (pending.length) {
      const entry = pending.pop()!;
      if (nodes.length >= MAX_PLAN_NODES || seen.has(entry.data)) return null;
      seen.add(entry.data);
      const type = planText(entry.data, "Node Type");
      if (!type) return null;
      const relation = planText(entry.data, "Relation Name");
      const index = planText(entry.data, "Index Name");
      nodes.push({
        ...entry,
        id: nodes.length,
        type,
        label: [type, relation && `on ${relation}`, index && `using ${index}`]
          .filter(Boolean)
          .join(" "),
      });
      const children = entry.data.Plans;
      if (children !== undefined && !Array.isArray(children)) return null;
      if (Array.isArray(children)) {
        if (children.length + pending.length + nodes.length > MAX_PLAN_NODES)
          return null;
        for (let i = children.length - 1; i >= 0; i--) {
          if (!record(children[i])) return null;
          // LIMIT/EXISTS and parallel workers can make estimate comparisons misleading.
          pending.push({
            data: children[i],
            depth: entry.depth + 1,
            partial:
              entry.partial ||
              ["Limit", "Gather", "Gather Merge"].includes(type) ||
              entry.data["Join Type"] === "Semi" ||
              entry.data["Join Type"] === "Anti",
          });
        }
      }
    }
    return {
      document,
      nodes,
      actual: planNumber(document.Plan, "Actual Loops") !== undefined,
    };
  } catch {
    return null;
  }
}

export function planFromResult(
  columns: { name: string }[],
  row: unknown[] | undefined,
  rowCount: number
) {
  if (
    columns.length !== 1 ||
    columns[0].name !== "QUERY PLAN" ||
    rowCount !== 1
  )
    return null;
  const cell = row?.[0];
  // Tauri transports JSON/text cells as tagged values; imported plans are unwrapped.
  const value =
    record(cell) && (cell.t === "Json" || cell.t === "Str")
      ? cellToString(cell, true)
      : cell;
  return parseQueryPlan(value);
}

export function formatPlanNumber(value: number | undefined, suffix = "") {
  return value === undefined
    ? "Not available"
    : `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })}${suffix}`;
}

export function planMetrics(
  plan: QueryPlan
): [string, number | undefined, string][] {
  const root = plan.nodes[0].data;
  return [
    ["Execution time", planNumber(plan.document, "Execution Time"), " ms"],
    ["Planning time", planNumber(plan.document, "Planning Time"), " ms"],
    ["Estimated total cost", planNumber(root, "Total Cost"), ""],
    ["Actual rows / loop", planNumber(root, "Actual Rows"), ""],
    ["Shared blocks read", planNumber(root, "Shared Read Blocks"), ""],
    ["Shared blocks hit", planNumber(root, "Shared Hit Blocks"), ""],
  ];
}
