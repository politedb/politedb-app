import {
  isListFilterOperator,
  isNullFilterOperator,
  isRangeFilterOperator,
  normalizeFilterOperator,
  type TableFilterCondition,
  type TableSort,
} from "src/lib/queries/sql/filters";

export type MongoFilterDoc = Record<string, unknown>;
export type MongoSortDoc = Record<string, 1 | -1>;

function operatorKey(operator: string) {
  return normalizeFilterOperator(operator).trim().toUpperCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function likeToRegex(pattern: string) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      const next = pattern[i + 1];
      if (next) {
        out += escapeRegex(next);
        i += 1;
      }
      continue;
    }
    if (char === "%") {
      out += ".*";
      continue;
    }
    if (char === "_") {
      out += ".";
      continue;
    }
    out += escapeRegex(char);
  }
  return `${out}$`;
}

function parseSafeInt(raw: string): number | null {
  if (!/^-?(0|[1-9]\d*)$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

function parseSafeFloat(raw: string): number | null {
  if (!/^-?(0|[1-9]\d*)\.\d+$/.test(raw) && !/^-?\d+[eE][+-]?\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}

function asObjectId(raw: string): { $oid: string } | null {
  if (!/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  return { $oid: raw.toLowerCase() };
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function coerceMongoFilterValues(raw: string): unknown[] {
  const trimmed = raw.trim();
  const out: unknown[] = [];
  if (/^true$/i.test(trimmed)) out.push(true);
  if (/^false$/i.test(trimmed)) out.push(false);
  if (/^null$/i.test(trimmed)) out.push(null);

  const intVal = parseSafeInt(trimmed);
  if (intVal !== null) {
    out.push(intVal);
  } else {
    const floatVal = parseSafeFloat(trimmed);
    if (floatVal !== null) out.push(floatVal);
  }

  const oid = asObjectId(trimmed);
  if (oid) out.push(oid);
  out.push(trimmed);
  return uniqueValues(out);
}

export function coerceMongoCompareValue(raw: string): unknown {
  const trimmed = raw.trim();
  const intVal = parseSafeInt(trimmed);
  if (intVal !== null) return intVal;
  const floatVal = parseSafeFloat(trimmed);
  if (floatVal !== null) return floatVal;
  const oid = asObjectId(trimmed);
  if (oid) return oid;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^null$/i.test(trimmed)) return null;
  return trimmed;
}

function equalityClause(column: string, raw: string): MongoFilterDoc {
  const values = coerceMongoFilterValues(raw);
  if (values.length === 1) return { [column]: values[0] };
  return { [column]: { $in: values } };
}

function inequalityClause(column: string, raw: string): MongoFilterDoc {
  const values = coerceMongoFilterValues(raw);
  if (values.length === 1) return { [column]: { $ne: values[0] } };
  return { [column]: { $nin: values } };
}

function regexClause(
  column: string,
  pattern: string,
  options?: string,
  negate = false
): MongoFilterDoc {
  const regex: Record<string, string> = { $regex: pattern };
  if (options) regex.$options = options;
  if (negate) return { [column]: { $not: regex } };
  return { [column]: regex };
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function clauseForFilter(filter: TableFilterCondition): MongoFilterDoc | null {
  const column = String(filter.column ?? "").trim();
  if (!filter.enabled || !column) return null;

  const op = operatorKey(filter.operator);
  const raw = String(filter.value ?? "");

  if (isNullFilterOperator(op)) {
    if (op === "IS NOT NULL") {
      return { [column]: { $ne: null } };
    }
    return { [column]: null };
  }

  if (isListFilterOperator(op)) {
    const items = splitList(raw).flatMap((item) =>
      coerceMongoFilterValues(item)
    );
    if (items.length === 0) return null;
    const unique = uniqueValues(items);
    return {
      [column]: op === "NOT IN" ? { $nin: unique } : { $in: unique },
    };
  }

  if (isRangeFilterOperator(op)) {
    const [startRaw = "", endRaw = ""] = splitList(raw).concat(["", ""]);
    const start = startRaw ? coerceMongoCompareValue(startRaw) : null;
    const end = endRaw ? coerceMongoCompareValue(endRaw) : null;
    if (start == null && end == null) return null;

    const bounds: Record<string, unknown> = {};
    if (start != null) bounds.$gte = start;
    if (end != null) bounds.$lte = end;
    if (op === "NOT BETWEEN") {
      return { [column]: { $not: bounds } };
    }
    return { [column]: bounds };
  }

  if (!raw.trim() && op !== "IS NULL" && op !== "IS NOT NULL") return null;

  switch (op) {
    case "=":
      return equalityClause(column, raw);
    case "!=":
    case "<>":
      return inequalityClause(column, raw);
    case "<":
      return { [column]: { $lt: coerceMongoCompareValue(raw) } };
    case ">":
      return { [column]: { $gt: coerceMongoCompareValue(raw) } };
    case "<=":
      return { [column]: { $lte: coerceMongoCompareValue(raw) } };
    case ">=":
      return { [column]: { $gte: coerceMongoCompareValue(raw) } };
    case "LIKE":
      return regexClause(column, likeToRegex(raw.trim()));
    case "ILIKE":
      return regexClause(column, likeToRegex(raw.trim()), "i");
    case "CONTAINS":
      return regexClause(column, escapeRegex(raw.trim()));
    case "NOT CONTAINS":
      return regexClause(column, escapeRegex(raw.trim()), undefined, true);
    case "STARTS WITH":
      return regexClause(column, `^${escapeRegex(raw.trim())}`);
    case "ENDS WITH":
      return regexClause(column, `${escapeRegex(raw.trim())}$`);
    default:
      return equalityClause(column, raw);
  }
}

export function enabledMongoFilters(filters?: TableFilterCondition[]) {
  return (filters ?? []).filter(
    (filter) => filter.enabled && String(filter.column ?? "").trim()
  );
}

export function buildMongoFilter(
  filters?: TableFilterCondition[],
  combine: "AND" | "OR" = "AND"
): MongoFilterDoc {
  const clauses = enabledMongoFilters(filters)
    .map(clauseForFilter)
    .filter((clause): clause is MongoFilterDoc => !!clause);

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0]!;
  return combine === "OR" ? { $or: clauses } : { $and: clauses };
}

export function buildMongoSort(sortBy?: TableSort | null): MongoSortDoc | null {
  const colName = sortBy?.colName?.trim();
  if (!colName) return null;
  const direction = sortBy?.direction === "desc" ? -1 : 1;
  return { [colName]: direction };
}

function quoteCollection(name: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `db.${name}`;
  return `db.getCollection(${JSON.stringify(name)})`;
}

export function formatMongoFindPreview(args: {
  collection: string;
  filters?: TableFilterCondition[];
  combine?: "AND" | "OR";
  sortBy?: TableSort | null;
  limit?: number;
  offset?: number;
}): string {
  const filter = buildMongoFilter(args.filters, args.combine ?? "AND");
  const sort = buildMongoSort(args.sortBy);
  let out = `${quoteCollection(args.collection)}.find(${JSON.stringify(filter)})`;
  if (sort) out += `.sort(${JSON.stringify(sort)})`;
  if ((args.offset ?? 0) > 0) out += `.skip(${args.offset})`;
  if (args.limit != null) out += `.limit(${args.limit})`;
  return out;
}
