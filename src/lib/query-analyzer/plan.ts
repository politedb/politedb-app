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
  analyzeHint?: string;
};

export const MAX_PLAN_BYTES = 5 * 1024 * 1024;
export const MAX_PLAN_NODES = 5000;

export function isPlanRecord(value: unknown): value is PlanRecord {
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
    if (!isPlanRecord(document) || !isPlanRecord(document.Plan)) return null;
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
          if (!isPlanRecord(children[i])) return null;
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

export function formatPlanNumber(value: number | undefined, suffix = "") {
  return value === undefined
    ? "Not available"
    : `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })}${suffix}`;
}

/** Parent of each node, from the pre-order depths every parser produces. */
export function planParents(plan: QueryPlan): (number | null)[] {
  const parents: (number | null)[] = [];
  const stack: PlanNode[] = [];
  for (const node of plan.nodes) {
    while (stack.length && stack[stack.length - 1]!.depth >= node.depth) {
      stack.pop();
    }
    parents.push(stack.length ? stack[stack.length - 1]!.id : null);
    stack.push(node);
  }
  return parents;
}

export type NodeHeat = {
  /** Node and its children: time over all loops, or estimated cost. */
  inclusive: number | undefined;
  /** This node alone: inclusive minus its children's inclusive, never < 0. */
  self: number | undefined;
  /** Shares of the whole plan (root inclusive), 0..1. */
  selfShare: number;
  inclusiveShare: number;
  /**
   * "shared": the node reads a CTE that several nodes read, so how much of the
   * CTE's work belongs to it cannot be told; `self` is left undefined.
   */
  attribution: "exact" | "shared";
};

export type PlanHeat = {
  /** Measured plans use actual time; estimated plans use planner cost. */
  kind: "time" | "cost";
  total: number | undefined;
  nodes: NodeHeat[];
  /** Node with the largest own share, when anything is measurable. */
  hottestId: number | null;
};

function inclusiveOf(node: PlanNode, kind: PlanHeat["kind"]) {
  if (kind === "cost") return planNumber(node.data, "Total Cost");
  const perLoop = planNumber(node.data, "Actual Total Time");
  if (perLoop === undefined) return undefined;
  // "Actual Total Time" is an average per loop; an inner node of a nested
  // loop that runs 10,000 times costs 10,000x that.
  const loops = planNumber(node.data, "Actual Loops");
  return perLoop * (loops === undefined ? 1 : loops);
}

/**
 * PostgreSQL shows a materialized CTE's producer as an InitPlan ("CTE name")
 * under some ancestor, but the executor runs it from inside the CTE Scan
 * nodes that read it. Its time is therefore part of those scans, not extra
 * work of the displayed parent: move it under its single reader, or, when
 * several nodes read it, keep it out of every subtraction and mark the
 * readers' own time as not attributable.
 */
function attributeCtes(
  plan: QueryPlan,
  timingParent: (number | null)[],
  shared: boolean[]
) {
  const readers = new Map<string, number[]>();
  for (const node of plan.nodes) {
    const name = planText(node.data, "CTE Name");
    if (node.type === "CTE Scan" && name) {
      readers.set(name, [...(readers.get(name) ?? []), node.id]);
    }
  }
  for (const node of plan.nodes) {
    const subplan = planText(node.data, "Subplan Name");
    if (!subplan?.startsWith("CTE ")) continue;
    const scans = readers.get(subplan.slice(4)) ?? [];
    if (scans.length === 1) {
      timingParent[node.id] = scans[0]!;
    } else if (scans.length > 1) {
      timingParent[node.id] = null;
      for (const scan of scans) shared[scan] = true;
    }
  }
}

/**
 * Where the plan spends its time (or cost). Parent figures include their
 * children, so a node's own share is what is left after subtracting them.
 * Parallel workers overlap, so their summed time can exceed the parent's;
 * shares are clamped to 0..1.
 */
export function planHeat(plan: QueryPlan): PlanHeat {
  const root = plan.nodes[0];
  const kind: PlanHeat["kind"] =
    plan.actual && root && inclusiveOf(root, "time") !== undefined
      ? "time"
      : "cost";
  const inclusive = plan.nodes.map((node) => inclusiveOf(node, kind));
  // Which node's own time a child's time is subtracted from. Usually the
  // displayed parent, except for CTEs (below).
  const timingParent = planParents(plan);
  const shared = plan.nodes.map(() => false);
  if (kind === "time") attributeCtes(plan, timingParent, shared);
  const childSum = plan.nodes.map(() => 0);
  const hasChildren = plan.nodes.map(() => false);
  timingParent.forEach((parent, id) => {
    if (parent === null) return;
    hasChildren[parent] = true;
    childSum[parent] += inclusive[id] ?? 0;
  });
  const total = root ? inclusive[0] : undefined;
  const share = (value: number | undefined) =>
    total && total > 0 && value !== undefined
      ? Math.min(1, Math.max(0, value / total))
      : 0;
  let hottestId: number | null = null;
  let hottest = 0;
  const nodes = plan.nodes.map((_node, id) => {
    const value = inclusive[id];
    const self =
      value === undefined || shared[id]
        ? undefined
        : hasChildren[id]
          ? Math.max(0, value - childSum[id]!)
          : value;
    const selfShare = share(self);
    if (selfShare > hottest) {
      hottest = selfShare;
      hottestId = id;
    }
    return {
      inclusive: value,
      self,
      selfShare,
      inclusiveShare: share(value),
      attribution: shared[id] ? ("shared" as const) : ("exact" as const),
    };
  });
  return { kind, total, nodes, hottestId };
}

export function planMetrics(
  plan: QueryPlan
): [string, number | undefined, string][] {
  const root = plan.nodes[0].data;
  return [
    ["Execution time", planNumber(plan.document, "Execution Time"), " ms"],
    ["Planning time", planNumber(plan.document, "Planning Time"), " ms"],
    ["Estimated total cost", planNumber(root, "Total Cost"), ""],
    ["Estimated rows", planNumber(root, "Plan Rows"), ""],
    ["Actual rows / loop", planNumber(root, "Actual Rows"), ""],
    ["Shared blocks read", planNumber(root, "Shared Read Blocks"), ""],
    ["Shared blocks hit", planNumber(root, "Shared Hit Blocks"), ""],
  ];
}
