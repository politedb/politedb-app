import { lexPostgres } from "src/lib/sql/pgLexer";
import {
  formatPlanNumber,
  isPlanRecord,
  planNumber,
  planParents,
  planText,
  type PlanNode,
  type QueryPlan,
} from "./plan";

/** How much a finding is likely to matter, most first. */
export type FindingSeverity = "high" | "medium" | "low";

export type PlanFinding = {
  nodeId: number;
  severity: FindingSeverity;
  title: string;
  detail: string;
  /**
   * A starting point to copy (never run by the app), e.g. an index matching
   * a filter. To be reviewed against the real workload first.
   */
  sql?: string;
};

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Loops a node ran (1 when the plan does not say). */
function loops(node: PlanNode): number {
  return planNumber(node.data, "Actual Loops") ?? 1;
}

/** Rows across all loops: actual rows are per-loop averages. */
function totalRows(node: PlanNode): number | undefined {
  const rows = planNumber(node.data, "Actual Rows");
  return rows === undefined ? undefined : rows * loops(node);
}

/** Raw metadata name (relation, schema) as an SQL identifier. */
function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Characters PostgreSQL operators are made of. */
const OPERATOR_CHARS = /^[-+*/<>=~!@#%^&|`?]$/;
/** Operators a default (B-tree) index can search. */
const BTREE_OPERATORS = new Set(["=", "<", ">", "<=", ">=", "<>", "!="]);
/**
 * Words that are values, not columns, where a column could stand
 * (`CURRENT_USER = owner`). The lexer does not tell keywords apart.
 */
const VALUE_WORDS = new Set([
  "CURRENT_CATALOG",
  "CURRENT_DATE",
  "CURRENT_ROLE",
  "CURRENT_SCHEMA",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "CURRENT_USER",
  "FALSE",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "NULL",
  "SESSION_USER",
  "SYSTEM_USER",
  "TRUE",
  "USER",
]);

/**
 * Columns compared in a PostgreSQL scan filter that has exactly the shape
 * PostgreSQL prints for a conjunction of simple comparisons:
 * `(leaf)` or `((leaf) AND (leaf) ...)`, where a leaf starts with a column
 * of this scan (`col`, `alias.col`, `"Col"`) followed by a B-tree
 * comparison (= < > <= >= <> !=, also with ANY) or IS [NOT] NULL. The
 * right-hand side is not inspected beyond balanced parentheses and an
 * explicit COLLATE (refused: the index would need that collation). Anything else (OR, functions or casts around the column,
 * boolean expressions compared with each other, value keywords, unclosed
 * tokens, another relation's column) gives null: no suggestion.
 */
function filterColumns(filter: string, ownNames: Set<string>): string[] | null {
  const { tokens, unterminated } = lexPostgres(filter);
  if (unterminated) return null;
  const list = tokens.filter((token) => token.kind !== "comment");
  const text = (i: number) => {
    const token = list[i];
    return token ? filter.slice(token.start, token.end) : "";
  };
  const kind = (i: number) => list[i]?.kind;
  const isOpen = (i: number) => kind(i) === "other" && text(i) === "(";
  const isClose = (i: number) => kind(i) === "other" && text(i) === ")";
  /** Index of the ")" closing the "(" at `open`, or -1. */
  const closing = (open: number) => {
    let depth = 0;
    for (let i = open; i < list.length; i++) {
      if (isOpen(i)) depth++;
      else if (isClose(i) && --depth === 0) return i;
    }
    return -1;
  };
  const unquote = (raw: string) =>
    raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
  const isColumnName = (i: number) =>
    kind(i) === "identifier" ||
    (kind(i) === "word" && !VALUE_WORDS.has(text(i).toUpperCase()));

  /** Column of the leaf spanning (open, close), or null. */
  const leafColumn = (open: number, close: number): string | null => {
    let i = open + 1;
    if (!isColumnName(i)) return null;
    if (text(i + 1) === "." && kind(i + 1) === "other") {
      if (!isColumnName(i + 2) || !ownNames.has(unquote(text(i)))) {
        return null;
      }
      i += 2;
    }
    const op = i + 1;
    if (kind(op) === "word" && text(op).toUpperCase() === "IS") {
      // Only `IS NULL` / `IS NOT NULL`, ending the leaf.
      const words = list
        .slice(op + 1, close)
        .map((token) => filter.slice(token.start, token.end).toUpperCase())
        .join(" ");
      if (words !== "NULL" && words !== "NOT NULL") return null;
    } else {
      // The lexer emits punctuation one character at a time: read the whole
      // operator, so `<@` or `<<` is never taken for `<`.
      let operator = "";
      let j = op;
      while (
        kind(j) === "other" &&
        OPERATOR_CHARS.test(text(j)) &&
        (j === op || list[j - 1]!.end === list[j]!.start)
      ) {
        operator += text(j);
        j++;
      }
      // A B-tree can search these; containment, pattern and other
      // operators need another index type, so nothing is suggested.
      if (!BTREE_OPERATORS.has(operator) || j >= close) return null;
      // An explicit collation decides how the comparison sorts; an index on
      // the plain column (its own collation) may not serve it.
      for (let k = j; k < close; k++) {
        if (kind(k) === "word" && text(k).toUpperCase() === "COLLATE") {
          return null;
        }
      }
    }
    // Words are names as PostgreSQL printed them; quoted identifiers come
    // with their quotes from the lexer.
    return text(i);
  };

  if (!isOpen(0) || closing(0) !== list.length - 1) return null;
  const end = list.length - 1;
  // A single leaf: `(col = ...)`.
  if (!isOpen(1)) {
    const column = leafColumn(0, end);
    return column ? [column] : null;
  }
  // A conjunction: `((leaf) AND (leaf) ...)`.
  const columns: string[] = [];
  let i = 1;
  while (true) {
    if (!isOpen(i)) return null;
    const close = closing(i);
    if (close < 0) return null;
    const column = leafColumn(i, close);
    if (!column) return null;
    if (!columns.includes(column)) columns.push(column);
    i = close + 1;
    if (i === end) return columns;
    if (kind(i) !== "word" || text(i).toUpperCase() !== "AND") return null;
    i++;
  }
}

/**
 * `CREATE INDEX` template for a PostgreSQL scan filter (see filterColumns):
 * up to three compared columns, in order of appearance. The filter is
 * tokenized, so string literals (and anything inside them) are never read
 * as columns, and the whole filter is validated before anything is
 * suggested.
 */
export function indexSuggestion(node: PlanNode): string | undefined {
  const relation = planText(node.data, "Relation Name");
  const filter = planText(node.data, "Filter");
  if (!relation || !filter) return undefined;
  const ownNames = new Set(
    [planText(node.data, "Alias"), relation].filter(
      (name): name is string => !!name
    )
  );
  const columns = filterColumns(filter, ownNames)?.slice(0, 3);
  if (!columns?.length) return undefined;
  const schema = planText(node.data, "Schema");
  const table = [schema, relation]
    .filter((part): part is string => !!part)
    .map(quoteName)
    .join(".");
  return `CREATE INDEX CONCURRENTLY ON ${table} (${columns.join(", ")});`;
}

/**
 * Heuristic review of a plan. Findings point at a node, carry a severity and
 * are sorted most severe first (plan order within a severity). Most checks
 * need measured numbers (EXPLAIN ANALYZE); none proves a bottleneck.
 */
export function analyzeQueryPlan(plan: QueryPlan): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const parents = planParents(plan);
  const children = plan.nodes.map(() => [] as PlanNode[]);
  for (const node of plan.nodes) {
    const parent = parents[node.id];
    if (parent != null) children[parent]!.push(node);
  }

  for (const node of plan.nodes) {
    const n = (key: string) => planNumber(node.data, key);
    if (n("Actual Loops") === 0) continue;
    const add = (
      severity: FindingSeverity,
      title: string,
      detail: string,
      sql?: string
    ) =>
      findings.push({
        nodeId: node.id,
        severity,
        title,
        detail,
        ...(sql ? { sql } : {}),
      });

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
        const sql = indexSuggestion(node);
        add(
          "high",
          "Selective filter after sequential scan",
          "More than 90% of scanned rows are discarded. Review an index matching the filter and ordering, existing indexes, and write overhead. A sequential scan is not inherently a problem." +
            (sql
              ? " The index below is a starting point: put equality columns before range columns."
              : ""),
          sql
        );
      } else if (!plan.actual) {
        add(
          "low",
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
        "medium",
        "Row estimate differs by at least 10x",
        "Check statistics freshness, skew, and correlated predicates. Consider ANALYZE on the affected relation, then recheck. Early termination or parameter choices can also explain differences."
      );
    }

    const sortOnDisk = planText(node.data, "Sort Space Type") === "Disk";
    if (sortOnDisk) {
      add(
        "medium",
        "Sort spilled to disk",
        "Review rows entering the sort and whether an index can supply the ordering. Consider session-local work_mem only after assessing concurrent sorts and memory capacity."
      );
    }
    const hashBatches = (n("Hash Batches") ?? 0) > 1;
    if (hashBatches) {
      add(
        "low",
        "Hash operation uses multiple batches",
        "Review build-side row estimates and memory pressure. Avoid globally increasing memory limits without evaluating concurrent queries."
      );
    }
    // Buffer counters include children: only this node's own writes count.
    const childTemp = children[node.id]!.reduce(
      (sum, child) =>
        sum + (planNumber(child.data, "Temp Written Blocks") ?? 0),
      0
    );
    const ownTemp = (n("Temp Written Blocks") ?? 0) - childTemp;
    if (ownTemp > 0 && !sortOnDisk && !hashBatches) {
      add(
        "medium",
        "Writes temporary files",
        `This node itself wrote ${formatPlanNumber(ownTemp)} temporary blocks (usually 8 kB each): its working data did not fit in work_mem. Reduce the rows reaching it, or review work_mem for this session.`
      );
    }

    // Nested Loop: the inner child runs once per outer row. PostgreSQL
    // labels it; InitPlans/SubPlans can come before the outer child.
    if (/nested loop/i.test(node.type)) {
      const own = children[node.id]!;
      const inner =
        own.find(
          (child) => planText(child.data, "Parent Relationship") === "Inner"
        ) ??
        (own.some((child) => planText(child.data, "Parent Relationship"))
          ? undefined
          : own[1]);
      const innerLoops = inner
        ? planNumber(inner.data, "Actual Loops")
        : undefined;
      if (innerLoops !== undefined && innerLoops >= 1000) {
        add(
          "high",
          "Nested loop repeats its inner side many times",
          `The inner side ran ${formatPlanNumber(innerLoops)} times, once per outer row. Check the outer row estimate and the inner side's time per loop: when each loop is not cheap, an index on the inner join key or a hash or merge join may do less work.`
        );
      }
    }

    if (
      planText(node.data, "Parent Relationship") === "SubPlan" &&
      (n("Actual Loops") ?? 0) >= 1000
    ) {
      add(
        "high",
        "Subquery runs once per row",
        `This subplan ran ${formatPlanNumber(n("Actual Loops"))} times: a correlated subquery is evaluated again for each outer row that reaches it. If it can be written as a join (or an EXISTS the planner can turn into a semi-join) without changing NULL or duplicate handling, the planner can usually do it once.`
      );
    }

    const heapFetches = n("Heap Fetches");
    const rows = totalRows(node);
    if (
      /index only scan/i.test(node.type) &&
      heapFetches !== undefined &&
      heapFetches >= 1000 &&
      heapFetches > (rows ?? 0) * 0.1
    ) {
      add(
        "medium",
        "Index-only scan still reads the table",
        `${formatPlanNumber(heapFetches)} rows were checked in the table because their pages are not marked all-visible. VACUUM the table (or tune autovacuum) so the visibility map is current.`
      );
    }

    // Lossy pages: the bitmap kept whole pages instead of rows. With B-tree
    // or GiST indexes that means it outgrew work_mem; BRIN is always lossy.
    const lossy = n("Lossy Heap Blocks") ?? 0;
    if (/bitmap heap scan/i.test(node.type) && lossy > 0) {
      const recheck = (n("Rows Removed by Index Recheck") ?? 0) * loops(node);
      add(
        "medium",
        "Bitmap scan became lossy",
        `${formatPlanNumber(lossy)} pages were kept whole and rechecked${recheck ? ` (${formatPlanNumber(recheck)} rows removed by the recheck)` : ""}. Unless the index is BRIN (which is lossy by design), the bitmap did not fit in work_mem: a more selective condition or more work_mem for this session keeps it exact.`
      );
    }

    const planned = n("Workers Planned");
    const launched = n("Workers Launched");
    if (planned !== undefined && launched !== undefined && launched < planned) {
      add(
        "medium",
        "Fewer parallel workers than planned",
        `${formatPlanNumber(launched)} of ${formatPlanNumber(planned)} planned workers started, so this part ran with less parallelism than the plan assumed. The server's worker limits (max_parallel_workers, max_worker_processes) were likely in use.`
      );
    }
  }

  // JIT is reported for the whole statement; attach it to the root.
  const jit = plan.document.JIT;
  const timing = isPlanRecord(jit) ? jit.Timing : undefined;
  const jitTotal = isPlanRecord(timing)
    ? planNumber(timing, "Total")
    : undefined;
  const execution = planNumber(plan.document, "Execution Time");
  // With parallel workers JIT time is summed across processes, so it is not
  // a share of the elapsed time.
  const parallel = plan.nodes.some(
    (node) => (planNumber(node.data, "Workers Launched") ?? 0) > 0
  );
  if (
    plan.nodes.length &&
    !parallel &&
    jitTotal !== undefined &&
    execution !== undefined &&
    jitTotal >= 100 &&
    jitTotal > execution * 0.1
  ) {
    findings.push({
      nodeId: 0,
      severity: "high",
      title: "JIT compilation takes a large share of the time",
      detail: `JIT took ${formatPlanNumber(Math.round(jitTotal))} ms of ${formatPlanNumber(Math.round(execution))} ms. For short queries it often costs more than it saves; compare with jit = off for this session, or review jit_above_cost.`,
    });
  }

  return findings
    .map((finding, order) => ({ finding, order }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] -
          SEVERITY_ORDER[b.finding.severity] || a.order - b.order
    )
    .map(({ finding }) => finding);
}
