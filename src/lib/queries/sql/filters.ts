import type { DatabaseEngine } from "src/types";
import { qIdent, qLiteral } from "./shared";

// Filter condition for table data (WHERE clause)
export type TableFilterCondition = {
  id: number;
  column: string;
  operator: string;
  value: string;
  enabled: boolean;
};

export type TableSort = {
  colName: string;
  direction: "asc" | "desc";
};

export type FilterOperator = {
  value: string;
  type: "op" | "separator";
  requiresValue?: boolean;
  inputHint?: "single" | "list" | "range" | "like" | "none";
};

export const FILTER_OPERATORS: FilterOperator[] = [
  { value: "=", type: "op", requiresValue: true, inputHint: "single" },
  { value: "!=", type: "op", requiresValue: true, inputHint: "single" },
  { value: "<>", type: "op", requiresValue: true, inputHint: "single" },
  { value: "<", type: "op", requiresValue: true, inputHint: "single" },
  { value: ">", type: "op", requiresValue: true, inputHint: "single" },
  { value: "<=", type: "op", requiresValue: true, inputHint: "single" },
  { value: ">=", type: "op", requiresValue: true, inputHint: "single" },
  { value: "sep#1", type: "separator" },
  { value: "BETWEEN", type: "op", requiresValue: true, inputHint: "range" },
  { value: "NOT BETWEEN", type: "op", requiresValue: true, inputHint: "range" },
  { value: "sep#2", type: "separator" },
  { value: "LIKE", type: "op", requiresValue: true, inputHint: "like" },
  { value: "ILIKE", type: "op", requiresValue: true, inputHint: "like" },
  { value: "sep#3", type: "separator" },
  { value: "IN", type: "op", requiresValue: true, inputHint: "list" },
  { value: "NOT IN", type: "op", requiresValue: true, inputHint: "list" },
  { value: "sep#4", type: "separator" },
  { value: "IS NULL", type: "op", requiresValue: false, inputHint: "none" },
  { value: "IS NOT NULL", type: "op", requiresValue: false, inputHint: "none" },
  { value: "sep#5", type: "separator" },
  { value: "Contains", type: "op", requiresValue: true, inputHint: "like" },
  { value: "Not contains", type: "op", requiresValue: true, inputHint: "like" },
  { value: "sep#6", type: "separator" },
  { value: "Starts with", type: "op", requiresValue: true, inputHint: "like" },
  { value: "Ends with", type: "op", requiresValue: true, inputHint: "like" },
] as const;

/** Case-insensitive lookup key; SQL branching uses this, UI keeps canonical `value` casing. */
function filterOperatorKey(operator: string) {
  return String(operator ?? "")
    .trim()
    .toUpperCase();
}

const FILTER_OPERATOR_MAP: Map<string, FilterOperator> = new Map(
  FILTER_OPERATORS.filter((op) => op.type === "op").map((op) => [
    filterOperatorKey(String(op.value ?? "")),
    op,
  ])
);

const VALUE_OPS: string[] = FILTER_OPERATORS.filter(
  (op) => op.type === "op" && op.requiresValue && op.inputHint === "single"
).map((op) => op.value);
const IN_OPS: string[] = FILTER_OPERATORS.filter(
  (op) => op.type === "op" && op.requiresValue && op.inputHint === "list"
).map((op) => op.value);
const NULL_OPS: string[] = FILTER_OPERATORS.filter(
  (op) => op.type === "op" && !op.requiresValue
).map((op) => op.value);
const RANGE_OPS: string[] = FILTER_OPERATORS.filter(
  (op) => op.type === "op" && op.requiresValue && op.inputHint === "range"
).map((op) => op.value);
const LIKE_OPS: string[] = FILTER_OPERATORS.filter(
  (op) => op.type === "op" && op.requiresValue && op.inputHint === "like"
).map((op) => op.value);

export function normalizeFilterOperator(operator: string) {
  const entry = FILTER_OPERATOR_MAP.get(filterOperatorKey(operator));
  if (entry?.value != null) return String(entry.value);
  return "=";
}

export function filterOperatorRequiresValue(operator: string) {
  return (
    FILTER_OPERATOR_MAP.get(filterOperatorKey(operator))?.requiresValue ?? true
  );
}

export function isNullFilterOperator(operator: string) {
  return !filterOperatorRequiresValue(operator);
}

export function isListFilterOperator(operator: string) {
  return (
    FILTER_OPERATOR_MAP.get(filterOperatorKey(operator))?.inputHint === "list"
  );
}

export function isRangeFilterOperator(operator: string) {
  return (
    FILTER_OPERATOR_MAP.get(filterOperatorKey(operator))?.inputHint === "range"
  );
}

export function buildWhereClause(
  filters: TableFilterCondition[],
  combineWith: "AND" | "OR",
  engine?: DatabaseEngine
): string {
  const parts = filters
    .filter((f) => f.enabled && (f.column ?? "").trim())
    .map((f) => {
      const col = qIdent(String(f.column).trim(), engine);
      const op = normalizeFilterOperator(f.operator);
      const opKey = filterOperatorKey(op);
      if (
        NULL_OPS.some((candidate) => filterOperatorKey(candidate) === opKey)
      ) {
        return `${col} ${op}`;
      }
      if (IN_OPS.some((candidate) => filterOperatorKey(candidate) === opKey)) {
        const raw = (f.value ?? "").trim();
        const values = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => qLiteral(s));
        if (values.length === 0) return "";
        return `${col} ${op} (${values.join(", ")})`;
      }
      if (
        RANGE_OPS.some((candidate) => filterOperatorKey(candidate) === opKey)
      ) {
        const [startRaw = "", endRaw = ""] = String(f.value ?? "")
          .split(",")
          .map((s) => s.trim());
        const bound = startRaw || endRaw;
        if (!bound) return "";

        const clause = `${col} ${op}`;
        if (startRaw && !endRaw) {
          return `${clause} ${qLiteral(startRaw, engine)}`;
        }
        if (!startRaw && endRaw) {
          return `${clause} ${qLiteral(endRaw, engine)}`;
        }
        return `${col} ${op} ${qLiteral(startRaw, engine)} AND ${qLiteral(endRaw, engine)}`;
      }
      if (
        LIKE_OPS.some((candidate) => filterOperatorKey(candidate) === opKey)
      ) {
        const val = (f.value ?? "").trim();
        if (!val) return "";
        const pattern =
          opKey === "STARTS WITH"
            ? `${val}%`
            : opKey === "ENDS WITH"
              ? `%${val}`
              : `%${val}%`;
        const literal = qLiteral(pattern, engine);
        if (opKey === "NOT CONTAINS") {
          return `${col} NOT LIKE ${literal}`;
        }
        if (opKey === "ILIKE") {
          if (engine === "oracle") {
            return `LOWER(${col}) LIKE LOWER(${literal})`;
          }
          return `${col} ILIKE ${literal}`;
        }
        return `${col} LIKE ${literal}`;
      }
      if (
        VALUE_OPS.some((candidate) => filterOperatorKey(candidate) === opKey)
      ) {
        const val = (f.value ?? "").trim();
        return `${col} ${op} ${qLiteral(val, engine)}`;
      }
      return `${col} = ${qLiteral(String(f.value ?? "").trim())}`;
    })
    .filter(Boolean);
  if (parts.length === 0) return "";
  return " WHERE " + parts.join(` ${combineWith} `);
}
