import { cellToString } from "src/utils/convert";
import type { DatabaseEngine } from "src/types";
import {
  MAX_PLAN_BYTES,
  MAX_PLAN_NODES,
  isPlanRecord,
  parseQueryPlan,
  planNumber,
  type PlanNode,
  type PlanRecord,
  type QueryPlan,
} from "./plan";

const ANALYZE_HINT: Partial<Record<DatabaseEngine, string>> = {
  postgres: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
  mysql: "EXPLAIN ANALYZE FORMAT=JSON",
  mariadb: "ANALYZE FORMAT=JSON",
  duckdb: "EXPLAIN ANALYZE",
  sqlserver: "SET STATISTICS XML ON — that executes the statement",
  oracle:
    "/*+ GATHER_PLAN_STATISTICS */ then DBMS_XPLAN.DISPLAY_CURSOR — that executes the statement",
};

function withHint(
  plan: QueryPlan | null,
  engine: DatabaseEngine
): QueryPlan | null {
  if (!plan) return null;
  return { ...plan, analyzeHint: ANALYZE_HINT[engine] };
}

function finish(
  document: PlanRecord,
  nodes: PlanNode[],
  actual: boolean
): QueryPlan | null {
  if (!nodes.length) return null;
  return { document, nodes, actual };
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => asText(item))
      .filter(Boolean)
      .join(", ");
    return joined || undefined;
  }
  return undefined;
}

function cellPrimitive(cell: unknown): unknown {
  if (cell && typeof cell === "object" && "t" in cell) {
    const tagged = cell as { t?: string; v?: unknown };
    if (tagged.t === "Null") return null;
    if (tagged.t === "I64" || tagged.t === "F64" || tagged.t === "Bool")
      return tagged.v;
    if (tagged.t === "Json") {
      const raw = String(tagged.v ?? "");
      if (raw.length > MAX_PLAN_BYTES) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return cellToString(cell, true);
  }
  return cell;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PLAN_BYTES) return value;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function rowCells(row: unknown): unknown[] {
  return Array.isArray(row) ? row : [];
}

function rowRecord(columns: { name: string }[], row: unknown): PlanRecord {
  const cells = rowCells(row);
  const out: PlanRecord = {};
  columns.forEach((column, index) => {
    out[column.name] = cellPrimitive(cells[index]);
  });
  return out;
}

function col(record: PlanRecord, names: string[]): unknown {
  const keys = Object.keys(record);
  for (const name of names) {
    const match = keys.find((key) => key.toLowerCase() === name.toLowerCase());
    if (match) return record[match];
  }
  return undefined;
}

function treeFromParents(
  items: {
    id: string;
    parent?: string;
    type: string;
    label: string;
    data: PlanRecord;
  }[]
): QueryPlan | null {
  if (!items.length || items.length > MAX_PLAN_NODES) return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const item of items) {
    const parent = item.parent;
    if (!parent || parent === item.id || !byId.has(parent)) {
      roots.push(item.id);
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(item.id);
    children.set(parent, list);
  }
  if (!roots.length) roots.push(items[0].id);
  const nodes: PlanNode[] = [];
  const pending = roots
    .slice()
    .reverse()
    .map((id) => ({ id, depth: 0 }));
  const seen = new Set<string>();
  while (pending.length) {
    const entry = pending.pop()!;
    if (seen.has(entry.id) || nodes.length >= MAX_PLAN_NODES) return null;
    seen.add(entry.id);
    const item = byId.get(entry.id);
    if (!item) continue;
    nodes.push({
      id: nodes.length,
      depth: entry.depth,
      type: item.type,
      label: item.label,
      partial: false,
      data: item.data,
    });
    const kids = children.get(entry.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      pending.push({ id: kids[i], depth: entry.depth + 1 });
    }
  }
  return finish({ rows: items.map((item) => item.data) }, nodes, false);
}

function attachNormalized(
  data: PlanRecord,
  fields: {
    type: string;
    relation?: string;
    index?: string;
    cost?: number;
    rows?: number;
    actualRows?: number;
    actualTime?: number;
    actualLoops?: number;
    filter?: string;
  }
): PlanRecord {
  const next: PlanRecord = {
    ...data,
    "Node Type": fields.type,
  };
  if (fields.relation) next["Relation Name"] = fields.relation;
  if (fields.index) next["Index Name"] = fields.index;
  if (fields.cost !== undefined) next["Total Cost"] = fields.cost;
  if (fields.rows !== undefined) next["Plan Rows"] = fields.rows;
  if (fields.actualRows !== undefined) next["Actual Rows"] = fields.actualRows;
  if (fields.actualTime !== undefined)
    next["Actual Total Time"] = fields.actualTime;
  if (fields.actualLoops !== undefined)
    next["Actual Loops"] = fields.actualLoops;
  if (fields.filter) next.Filter = fields.filter;
  return next;
}

function labelOf(type: string, relation?: string, index?: string) {
  return [type, relation && `on ${relation}`, index && `using ${index}`]
    .filter(Boolean)
    .join(" ");
}

function firstJsonCell(rows: unknown[][]): unknown {
  if (rows.length !== 1 || rowCells(rows[0]).length !== 1) return undefined;
  return parseJsonValue(cellPrimitive(rows[0][0]));
}

function parsePostgresLike(value: unknown): QueryPlan | null {
  return parseQueryPlan(value);
}

function mysqlCost(block: PlanRecord): number | undefined {
  const info = block.cost_info;
  if (!isPlanRecord(info)) return asNumber(block.query_cost);
  return (
    asNumber(info.query_cost) ??
    asNumber(info.read_cost) ??
    asNumber(info.prefix_cost)
  );
}

function walkMysql(value: unknown, depth: number, nodes: PlanNode[]): boolean {
  if (!isPlanRecord(value) || nodes.length >= MAX_PLAN_NODES) return false;
  if (isPlanRecord(value.query_block))
    return walkMysql(value.query_block, depth, nodes);

  const wrappers = [
    "ordering_operation",
    "grouping_operation",
    "duplicates_removal",
    "windowing",
    "buffer_result",
    "union_result",
  ] as const;
  for (const wrapper of wrappers) {
    if (isPlanRecord(value[wrapper])) {
      const child = value[wrapper] as PlanRecord;
      const type = wrapper.replace(/_/g, " ");
      const data = attachNormalized(child, {
        type,
        cost: mysqlCost(child),
        rows: asNumber(child.rows),
      });
      nodes.push({
        id: nodes.length,
        depth,
        type,
        label: type,
        partial: wrapper === "union_result",
        data,
      });
      if (Array.isArray(child.query_specifications)) {
        for (const spec of child.query_specifications) {
          if (!walkMysql(spec, depth + 1, nodes)) return false;
        }
      }
      return walkMysql(
        { ...child, [wrapper]: undefined, query_specifications: undefined },
        depth + 1,
        nodes
      );
    }
  }

  const nested = value.nested_loop;
  if (Array.isArray(nested)) {
    nodes.push({
      id: nodes.length,
      depth,
      type: "Nested Loop",
      label: "Nested Loop",
      partial: false,
      data: attachNormalized(value, {
        type: "Nested Loop",
        cost: mysqlCost(value),
      }),
    });
    for (const item of nested) {
      if (!walkMysql(item, depth + 1, nodes)) return false;
    }
    return true;
  }

  if (isPlanRecord(value.table)) {
    const table = value.table;
    const type =
      asText(table.access_type) === "ALL"
        ? "Seq Scan"
        : asText(table.access_type) || asText(table.using_index) || "Table";
    const relation = asText(table.table_name);
    const index = asText(table.key);
    const actualLoops = asNumber(table.actual_loops);
    const data = attachNormalized(table, {
      type,
      relation,
      index,
      cost: mysqlCost(table) ?? mysqlCost(value),
      rows: asNumber(table.rows_examined_per_scan) ?? asNumber(table.rows),
      actualRows: asNumber(table.actual_rows),
      actualLoops,
      filter: asText(table.attached_condition),
    });
    nodes.push({
      id: nodes.length,
      depth,
      type,
      label: labelOf(type, relation, index),
      partial: false,
      data,
    });
    if (isPlanRecord(table.materialized_from_subquery)) {
      return walkMysql(table.materialized_from_subquery, depth + 1, nodes);
    }
    return true;
  }

  if (isPlanRecord(value.materialized_from_subquery)) {
    return walkMysql(value.materialized_from_subquery, depth, nodes);
  }

  return true;
}

function parseMysqlJson(value: unknown): QueryPlan | null {
  const document = parseJsonValue(value);
  if (!isPlanRecord(document)) return null;
  const nodes: PlanNode[] = [];
  if (!walkMysql(document, 0, nodes) || !nodes.length) return null;
  const actual = nodes.some(
    (node) => planNumber(node.data, "Actual Rows") !== undefined
  );
  return finish(document, nodes, actual);
}

function parseSqlite(columns: { name: string }[], rows: unknown[][]) {
  const items = rows.map((row, index) => {
    const rec = rowRecord(columns, row);
    const id = asText(col(rec, ["id", "selectid"])) ?? String(index);
    const parentRaw = col(rec, ["parent", "from"]);
    const parent =
      parentRaw === 0 || parentRaw === "0" || parentRaw == null
        ? undefined
        : asText(parentRaw);
    const detail = asText(col(rec, ["detail", "notused"])) ?? "Plan";
    const type = detail.split(/\s+/)[0] || "Plan";
    return {
      id,
      parent,
      type,
      label: detail,
      data: attachNormalized(rec, { type, filter: detail }),
    };
  });
  return treeFromParents(items);
}

function parseSqlServer(columns: { name: string }[], rows: unknown[][]) {
  const items = rows.map((row, index) => {
    const rec = rowRecord(columns, row);
    const id = asText(col(rec, ["NodeId", "nodeid"])) ?? String(index);
    const parentRaw = col(rec, ["Parent", "parent"]);
    const parent =
      parentRaw === 0 || parentRaw === "0" || parentRaw == null
        ? undefined
        : asText(parentRaw);
    const type =
      asText(col(rec, ["PhysicalOp", "LogicalOp", "Type"])) || "Query";
    const stmt = asText(col(rec, ["StmtText", "Argument"]));
    return {
      id,
      parent,
      type,
      label: stmt ? `${type} ${stmt}` : type,
      data: attachNormalized(rec, {
        type,
        cost: asNumber(col(rec, ["TotalSubtreeCost"])),
        rows: asNumber(col(rec, ["EstimateRows"])),
        filter: stmt,
      }),
    };
  });
  const plan = treeFromParents(items);
  return plan;
}

function parseSnowflakeJson(value: unknown): QueryPlan | null {
  const document = parseJsonValue(value);
  if (!isPlanRecord(document) || !Array.isArray(document.Operations))
    return null;
  const items = document.Operations.map((operation, index) => {
    if (!isPlanRecord(operation)) return null;
    const type = asText(operation.operation) || "Operation";
    const relation = asText(operation.objects);
    const parent = asText(operation.parent);
    return {
      id: asText(operation.id) ?? String(index),
      parent: parent && parent !== "null" ? parent : undefined,
      type,
      label: labelOf(type, relation),
      data: attachNormalized(operation, {
        type,
        relation,
        rows: asNumber(operation.rowCount) ?? asNumber(operation.rows),
        cost: asNumber(operation.cost),
        filter: asText(operation.expressions),
      }),
    };
  }).filter(Boolean) as {
    id: string;
    parent?: string;
    type: string;
    label: string;
    data: PlanRecord;
  }[];
  return treeFromParents(items);
}

function parseSnowflakeTabular(columns: { name: string }[], rows: unknown[][]) {
  const items = rows.map((row, index) => {
    const rec = rowRecord(columns, row);
    const id = asText(col(rec, ["id", "step"])) ?? String(index);
    const parent = asText(col(rec, ["parent"]));
    const type = asText(col(rec, ["operation"])) || "Operation";
    const relation = asText(col(rec, ["objects"]));
    return {
      id,
      parent,
      type,
      label: labelOf(type, relation),
      data: attachNormalized(rec, {
        type,
        relation,
        rows: asNumber(col(rec, ["rows", "rowcount"])),
        filter: asText(col(rec, ["expressions"])),
      }),
    };
  });
  return treeFromParents(items);
}

function parseTextLines(lines: string[]): QueryPlan | null {
  const cleaned = lines
    .map((line) => line.replace(/[┌┐└┘├┤│─┬┴┼╭╮╯╰]/g, " ").replace(/\s+$/g, ""))
    .filter((line) => line.trim() && !/^[-+|]+$/.test(line.trim()));
  if (!cleaned.length) return null;
  const nodes: PlanNode[] = [];
  for (const line of cleaned) {
    if (nodes.length >= MAX_PLAN_NODES) return null;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const text = line.trim();
    const depth = Math.min(8, Math.floor(indent / 2));
    const type = text.split(/\s+/)[0] || "Plan";
    nodes.push({
      id: nodes.length,
      depth,
      type,
      label: text,
      partial: false,
      data: attachNormalized({ text }, { type, filter: text }),
    });
  }
  return finish(
    { lines: cleaned },
    nodes,
    /actual|times:|took /i.test(cleaned.join("\n"))
  );
}

function parseOracleXplan(rows: unknown[][]): QueryPlan | null {
  const lines = rows
    .map((row) =>
      rowCells(row)
        .map((cell) => cellToString(cellPrimitive(cell) ?? cell, true) ?? "")
        .join(" ")
        .trim()
    )
    .filter(Boolean);
  const nodes: PlanNode[] = [];
  for (const line of lines) {
    const match = line.match(
      /^\|?\s*\*?(\d+)\s*\|([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)\|/
    );
    if (!match) continue;
    if (nodes.length >= MAX_PLAN_NODES) return null;
    const operation = match[2].replace(/\s+$/g, "");
    const depth = Math.min(
      8,
      Math.floor((operation.match(/^\s*/)?.[0].length ?? 0) / 2)
    );
    const type = operation.trim() || "Plan";
    const relation = match[3].trim() || undefined;
    nodes.push({
      id: nodes.length,
      depth,
      type,
      label: labelOf(type, relation),
      partial: false,
      data: attachNormalized(
        { Id: Number(match[1]), Operation: type, Name: relation },
        {
          type,
          relation,
          rows: asNumber(match[4]),
          cost: asNumber(match[5]),
        }
      ),
    });
  }
  if (nodes.length) return finish({ lines }, nodes, false);
  return parseTextLines(lines);
}

function parseTabularFallback(
  columns: { name: string }[],
  rows: unknown[][]
): QueryPlan | null {
  if (!rows.length) return null;
  const names = columns.map((column) => column.name.toLowerCase());
  if (names.includes("id") && names.includes("parent")) {
    return parseSqlite(columns, rows);
  }
  if (names.includes("nodeid") && names.includes("parent")) {
    return parseSqlServer(columns, rows);
  }
  if (
    names.includes("operation") &&
    (names.includes("id") || names.includes("parent"))
  ) {
    return parseSnowflakeTabular(columns, rows);
  }
  if (
    names.includes("detail") &&
    (names.includes("id") || names.includes("parent"))
  ) {
    return parseSqlite(columns, rows);
  }
  if (
    names.includes("id") &&
    names.includes("select_type") &&
    names.includes("table")
  ) {
    const items = rows.map((row, index) => {
      const rec = rowRecord(columns, row);
      const type =
        asText(col(rec, ["type"])) === "ALL"
          ? "Seq Scan"
          : asText(col(rec, ["type"])) || "Table";
      const relation = asText(col(rec, ["table"]));
      const indexName = asText(col(rec, ["key"]));
      return {
        id: asText(col(rec, ["id"])) ?? String(index),
        parent: undefined,
        type,
        label: labelOf(type, relation, indexName),
        data: attachNormalized(rec, {
          type,
          relation,
          index: indexName,
          rows: asNumber(col(rec, ["rows"])),
          filter: asText(col(rec, ["extra"])),
        }),
      };
    });
    return treeFromParents(items);
  }
  if (columns.length === 1 || columns.length === 2) {
    const lines = rows.map((row) => {
      const cells = rowCells(row);
      const joined = cells
        .map((cell) => cellToString(cellPrimitive(cell) ?? cell, true) ?? "")
        .filter(Boolean)
        .join(": ");
      return joined;
    });
    if (rows.length === 1 && columns.length === 1) {
      const raw = cellPrimitive(rows[0][0]);
      const json = parseJsonValue(raw);
      const parsed =
        parseMysqlJson(json) ??
        parseSnowflakeJson(json) ??
        parsePostgresLike(json);
      if (parsed) return parsed;
      const text =
        typeof raw === "string" ? raw : (cellToString(raw, true) ?? "");
      if (text.includes("\n")) return parseTextLines(text.split("\n"));
      return null;
    }
    return parseTextLines(lines);
  }
  return null;
}

function parseAnyJsonPlan(value: unknown): QueryPlan | null {
  return (
    parsePostgresLike(value) ??
    parseMysqlJson(value) ??
    parseSnowflakeJson(value)
  );
}

function jsonFromRows(columns: { name: string }[], rows: unknown[][]): unknown {
  const single = firstJsonCell(rows);
  if (single !== undefined) return single;
  if (columns.length === 1) {
    const joined = rows
      .map((row) => {
        const cell = rowCells(row)[0];
        return cellToString(cellPrimitive(cell) ?? cell, true) ?? "";
      })
      .join("\n")
      .trim();
    return parseJsonValue(joined);
  }
  if (rows.length === 1) {
    for (const cell of rowCells(rows[0])) {
      const parsed = parseAnyJsonPlan(parseJsonValue(cellPrimitive(cell)));
      if (parsed) return parseJsonValue(cellPrimitive(cell));
    }
  }
  return undefined;
}

function rowsAsPlan(
  columns: { name: string }[],
  rows: unknown[][]
): QueryPlan | null {
  if (!rows.length) return null;
  const nodes: PlanNode[] = rows.map((row, index) => {
    const rec = rowRecord(columns, row);
    const type =
      asText(
        col(rec, [
          "Node Type",
          "operation",
          "PhysicalOp",
          "type",
          "detail",
          "explain_key",
        ])
      ) || "Step";
    const label =
      asText(col(rec, ["detail", "explain_value", "StmtText", "label"])) ||
      columns
        .map((column) => {
          const value = asText(rec[column.name]);
          return value ? `${column.name}: ${value}` : null;
        })
        .filter(Boolean)
        .join(" · ") ||
      `Step ${index + 1}`;
    return {
      id: index,
      depth: 0,
      type,
      label,
      partial: false,
      data: attachNormalized(rec, {
        type,
        cost: asNumber(col(rec, ["Total Cost", "TotalSubtreeCost", "cost"])),
        rows: asNumber(col(rec, ["Plan Rows", "EstimateRows", "rows"])),
        filter: asText(col(rec, ["Filter", "detail", "Extra", "expressions"])),
      }),
    };
  });
  return finish(
    {
      columns: columns.map((column) => column.name),
      rows: nodes.map((node) => node.data),
    },
    nodes,
    false
  );
}

export function parseImportedPlan(value: unknown): QueryPlan | null {
  return parseAnyJsonPlan(value);
}

export function planFromResult(
  engine: DatabaseEngine,
  columns: { name: string }[],
  rows: unknown[][] | undefined,
  options?: { fallback?: boolean }
): QueryPlan | null {
  if (!columns.length || !rows?.length) return null;
  const json = jsonFromRows(columns, rows);
  let plan: QueryPlan | null = null;
  switch (engine) {
    case "postgres":
      plan = parsePostgresLike(json);
      break;
    case "mysql":
    case "mariadb":
      plan = parseMysqlJson(json) ?? parseTabularFallback(columns, rows);
      break;
    case "sqlite":
    case "d1":
    case "turso":
      plan = parseSqlite(columns, rows);
      break;
    case "sqlserver":
      plan =
        parseSqlServer(columns, rows) ?? parseTabularFallback(columns, rows);
      break;
    case "snowflake":
      plan = parseSnowflakeJson(json) ?? parseSnowflakeTabular(columns, rows);
      break;
    case "oracle":
      plan = parseOracleXplan(rows);
      break;
    case "clickhouse":
      plan = parseAnyJsonPlan(json) ?? parseTabularFallback(columns, rows);
      break;
    case "duckdb":
      plan = parseAnyJsonPlan(json) ?? parseTabularFallback(columns, rows);
      break;
    default:
      plan = parseTabularFallback(columns, rows);
  }
  if (!plan) plan = parseAnyJsonPlan(json);
  if (engine === "postgres") return withHint(plan, engine);
  if (!plan) plan = parseTabularFallback(columns, rows);
  if (!plan && options?.fallback) plan = rowsAsPlan(columns, rows);
  return withHint(plan, engine);
}
