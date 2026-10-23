import {
  formatPlanNumber,
  planNumber,
  type NodeHeat,
  type PlanHeat,
  type PlanNode,
  type PlanRecord,
  type QueryPlan,
} from "./plan";

export type DetailField = {
  label: string;
  value: string;
  /** Expressions and keys read better in a monospace font. */
  code?: boolean;
};

export type DetailGroup = {
  id: "time" | "rows" | "conditions" | "io" | "other";
  title: string;
  fields: DetailField[];
};

/** Structure and identity fields shown elsewhere (tree, title). */
const STRUCTURE_FIELDS = new Set([
  "Plans",
  "Plan",
  "query_block",
  "nested_loop",
  "Operations",
  "lines",
  "rows",
  "columns",
  "text",
  "Node Type",
  "Relation Name",
  "Index Name",
]);

const TIME_FIELDS: [string, string, string][] = [
  ["Startup Cost", "Startup cost", ""],
  ["Total Cost", "Total cost", ""],
  ["Actual Startup Time", "First row / loop", " ms"],
  ["Actual Total Time", "Time / loop", " ms"],
  ["Actual Loops", "Loops", ""],
];

const ROW_FIELDS: [string, string][] = [
  ["Plan Rows", "Estimated rows"],
  ["Actual Rows", "Actual rows / loop"],
  ["Rows Removed by Filter", "Removed by filter / loop"],
  ["Rows Removed by Index Recheck", "Removed by index recheck / loop"],
  ["Rows Removed by Join Filter", "Removed by join filter / loop"],
  ["Heap Fetches", "Heap fetches"],
  ["Plan Width", "Row width (bytes)"],
];

const CONDITION_FIELDS = [
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Join Filter",
  "Hash Cond",
  "Merge Cond",
  "Join Type",
  "Sort Key",
  "Presorted Key",
  "Group Key",
  "Strategy",
  "Scan Direction",
  "Subplan Name",
  "CTE Name",
  "Function Name",
  "Alias",
];

const IO_FIELDS = [
  "Shared Hit Blocks",
  "Shared Read Blocks",
  "Shared Dirtied Blocks",
  "Shared Written Blocks",
  "Local Hit Blocks",
  "Local Read Blocks",
  "Temp Read Blocks",
  "Temp Written Blocks",
  "I/O Read Time",
  "I/O Write Time",
  "Sort Method",
  "Sort Space Used",
  "Sort Space Type",
  "Hash Buckets",
  "Hash Batches",
  "Peak Memory Usage",
  "Workers Planned",
  "Workers Launched",
];

function display(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : null;
  if (typeof value === "number")
    return Number.isFinite(value) ? formatPlanNumber(value) : null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(", ");
  }
  return null; // nested objects belong to the tree or the JSON view
}

function percent(share: number) {
  return `${(share * 100).toFixed(share >= 0.1 || share === 0 ? 0 : 1)}%`;
}

/**
 * The selected node's fields, grouped. False flags, empty values and
 * structure fields are left out; whatever is not recognised goes to "Other".
 */
export function nodeDetailGroups(
  node: PlanNode,
  heat: NodeHeat,
  kind: PlanHeat["kind"],
  options: { shares: boolean } = { shares: true }
): DetailGroup[] {
  const data: PlanRecord = node.data;
  const used = new Set<string>();
  const take = (key: string) => {
    used.add(key);
    return data[key];
  };

  const time: DetailField[] = [];
  // A share of a one-node plan is always 100%; it says nothing.
  if (options.shares && heat.attribution === "shared") {
    time.push({
      label: "Own share",
      value: "Not separable: several nodes read this CTE",
    });
  } else if (
    options.shares &&
    heat.self !== undefined &&
    heat.inclusive !== undefined
  ) {
    time.push({ label: "Own share", value: percent(heat.selfShare) });
    time.push({
      label: "With children",
      value: percent(heat.inclusiveShare),
    });
    if (kind === "time") {
      time.push({
        label: "Time, all loops",
        value: formatPlanNumber(heat.inclusive, " ms"),
      });
    }
  }
  for (const [key, label, unit] of TIME_FIELDS) {
    const value = planNumber(data, key);
    used.add(key);
    if (value !== undefined)
      time.push({ label, value: formatPlanNumber(value, unit) });
  }

  const rows: DetailField[] = [];
  for (const [key, label] of ROW_FIELDS) {
    const value = planNumber(data, key);
    used.add(key);
    if (value !== undefined)
      rows.push({ label, value: formatPlanNumber(value) });
  }
  const estimated = planNumber(data, "Plan Rows");
  const actual = planNumber(data, "Actual Rows");
  if (estimated !== undefined && actual !== undefined && !node.partial) {
    const ratio =
      Math.max(actual, estimated) / Math.max(1, Math.min(actual, estimated));
    if (ratio >= 2) {
      rows.push({
        label: "Estimate off by",
        value: `${formatPlanNumber(Math.round(ratio * 10) / 10)}x (${actual > estimated ? "under" : "over"}estimated)`,
      });
    }
  }

  const conditions: DetailField[] = [];
  for (const key of CONDITION_FIELDS) {
    const value = display(take(key));
    if (value) conditions.push({ label: key, value, code: true });
  }

  const io: DetailField[] = [];
  for (const key of IO_FIELDS) {
    const raw = take(key);
    const value =
      typeof raw === "number"
        ? formatPlanNumber(raw, key.endsWith("Time") ? " ms" : "")
        : display(raw);
    if (value) io.push({ label: key, value });
  }

  const other: DetailField[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (used.has(key) || STRUCTURE_FIELDS.has(key)) continue;
    const value = display(raw);
    if (value) other.push({ label: key, value, code: typeof raw === "string" });
  }

  return (
    [
      { id: "time", title: kind === "time" ? "Time" : "Cost", fields: time },
      { id: "rows", title: "Rows", fields: rows },
      { id: "conditions", title: "Conditions", fields: conditions },
      { id: "io", title: "I/O and memory", fields: io },
      { id: "other", title: "Other fields", fields: other },
    ] satisfies DetailGroup[]
  ).filter((group) => group.fields.length > 0);
}

export type MetricComparison = {
  label: string;
  unit: string;
  baseline: number | undefined;
  current: number | undefined;
  /** current / baseline - 1, when both are known and baseline > 0. */
  change: number | undefined;
};

/** Plan-level figures side by side; lower is better for all of them. */
export function comparePlans(
  current: QueryPlan,
  baseline: QueryPlan,
  metrics: (plan: QueryPlan) => [string, number | undefined, string][]
): MetricComparison[] {
  const base = new Map(
    metrics(baseline).map(([label, value]) => [label, value])
  );
  return metrics(current)
    .map(([label, value, unit]) => {
      const before = base.get(label);
      return {
        label,
        unit,
        baseline: before,
        current: value,
        change:
          before !== undefined && value !== undefined && before > 0
            ? value / before - 1
            : undefined,
      };
    })
    .filter((row) => row.baseline !== undefined || row.current !== undefined);
}

/** Heat level of a node's own share, for colouring. */
export function heatLevel(
  selfShare: number
): "high" | "medium" | "low" | "none" {
  if (selfShare >= 0.5) return "high";
  if (selfShare >= 0.2) return "medium";
  if (selfShare >= 0.05) return "low";
  return "none";
}
