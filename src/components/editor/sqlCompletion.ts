import * as monaco from "monaco-editor";
import type { TableItem } from "src/types";

/**
 * Smart SQL completion (TablePlus-ish).
 * - Register ONCE, ctx via getter (ref).
 * - No icons in label (icons via CompletionItemKind).
 * - Uses filterText so typing "se" matches "SELECT".
 * - Heuristic state machine (no heavy parsing).
 */

export type CompletionCtx = {
  schemas: string[];
  activeSchema?: string;
  tables: TableItem[]; // { schema, name }
  columnsByTable?: Record<string, string[]>; // key: schema.table
};

type AliasRef = { schema?: string; table: string };

type DotContext =
  | { type: "aliasOrSchema"; base: string }
  | { type: "schemaTable"; schema: string; table: string };

type PostTableCtx =
  | { kind: "postFrom"; hasAlias: boolean }
  | { kind: "postJoin"; hasAlias: boolean };

type EditorState =
  | "DOT"
  | "POST_FROM_TABLE"
  | "POST_JOIN_TABLE"
  | "EXPECT_TABLE"
  | "EXPECT_COLUMN"
  | "DEFAULT";

type ParsedCtx = {
  lastKeyword: string;
  dot: DotContext | null;
  postTable: PostTableCtx | null;
  lastTable?: { schema?: string; table?: string };
  aliasMap: Record<string, AliasRef>;
  recentTables: Array<{ schema?: string; table: string; alias?: string }>;
};

/* =========================
 * Constants
 * ========================= */

const KW_LIGHT = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "AND",
  "OR",
  "ON",
  "AS",
  "INSERT",
  "UPDATE",
  "DELETE",
];

const POST_FROM_KW = [
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
];

const POST_JOIN_KW = [
  "ON",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
];

const EXPR_KW = ["AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN"];

const OPERATORS = ["=", "<>", "!=", "<", ">", "<=", ">=", "IN", "LIKE"];

const FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE"];

/* =========================
 * Utils
 * ========================= */

function makeKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function getWordRange(model: monaco.editor.ITextModel, pos: monaco.Position) {
  const w = model.getWordUntilPosition(pos);
  return new monaco.Range(
    pos.lineNumber,
    w.startColumn,
    pos.lineNumber,
    w.endColumn
  );
}

function getContextText(
  model: monaco.editor.ITextModel,
  pos: monaco.Position,
  maxChars = 300
) {
  const offset = model.getOffsetAt(pos);
  return model.getValue().slice(Math.max(0, offset - maxChars), offset);
}

function normalizeCtx(s: string) {
  return s.replace(/\s+/g, " ").trimEnd();
}

function lastKeyword(ctx: string) {
  const up = ctx.toUpperCase();
  const keys = ["FROM", "JOIN", "WHERE", "ON", "AND", "OR", "SET", "SELECT"];
  let best = "";
  let bestI = -1;
  for (const k of keys) {
    const i = up.lastIndexOf(k);
    if (i > bestI) {
      bestI = i;
      best = k;
    }
  }
  return best;
}

/* =========================
 * Parse tables / aliases
 * ========================= */

function parseTablesAndAliases(ctx: string) {
  const re =
    /\b(FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\.([a-zA-Z0-9_]+))?(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/gi;

  const aliasMap: Record<string, AliasRef> = {};
  const recentTables: Array<{
    schema?: string;
    table: string;
    alias?: string;
  }> = [];
  let last: { schema?: string; table?: string } = {};

  let m: RegExpExecArray | null;
  while ((m = re.exec(ctx)) !== null) {
    const schema = m[3] ? m[2] : undefined;
    const table = m[3] ?? m[2];
    const alias = m[4];

    last = { schema, table };
    recentTables.push({ schema, table, alias });

    if (alias) aliasMap[alias] = { schema, table };
  }

  return {
    aliasMap,
    last,
    recentTables: recentTables.slice(-2),
  };
}

function detectDotContext(ctx: string): DotContext | null {
  const t = ctx.split(" ").pop() ?? "";
  if (!t.endsWith(".")) return null;

  const parts = t.slice(0, -1).split(".");
  if (parts.length === 1) return { type: "aliasOrSchema", base: parts[0] };
  if (parts.length === 2)
    return { type: "schemaTable", schema: parts[0], table: parts[1] };
  return null;
}

function detectPostTableContext(ctx: string): PostTableCtx | null {
  const s = normalizeCtx(ctx);

  const reNoAlias = /\b(FROM|JOIN)\s+([a-zA-Z0-9_.]+)$/i;
  const reWithAlias =
    /\b(FROM|JOIN)\s+([a-zA-Z0-9_.]+)\s+(?:AS\s+)?([a-zA-Z0-9_]+)$/i;

  if (reWithAlias.test(s)) {
    return s.toUpperCase().includes("FROM")
      ? { kind: "postFrom", hasAlias: true }
      : { kind: "postJoin", hasAlias: true };
  }

  if (reNoAlias.test(s)) {
    return s.toUpperCase().includes("FROM")
      ? { kind: "postFrom", hasAlias: false }
      : { kind: "postJoin", hasAlias: false };
  }

  return null;
}

function resolveState(p: ParsedCtx): EditorState {
  if (p.dot) return "DOT";
  if (p.postTable?.kind === "postFrom") return "POST_FROM_TABLE";
  if (p.postTable?.kind === "postJoin") return "POST_JOIN_TABLE";
  if (["FROM", "JOIN", "UPDATE", "INTO"].includes(p.lastKeyword))
    return "EXPECT_TABLE";
  if (["SELECT", "WHERE", "ON", "AND", "OR", "SET"].includes(p.lastKeyword))
    return "EXPECT_COLUMN";
  return "DEFAULT";
}

/* =========================
 * Completion item builders
 * ========================= */

const kw = (range: monaco.Range, t: string) => ({
  label: t,
  filterText: t,
  kind: monaco.languages.CompletionItemKind.Keyword,
  insertText: t,
  range,
});

const tableItem = (range: monaco.Range, t: string) => ({
  label: t,
  filterText: t,
  kind: monaco.languages.CompletionItemKind.Struct,
  insertText: t,
  range,
});

const colItem = (range: monaco.Range, t: string) => ({
  label: t,
  filterText: t.split(".").pop(),
  kind: monaco.languages.CompletionItemKind.Field,
  insertText: t,
  range,
});

/* =========================
 * Public API
 * ========================= */

export function registerSqlCompletionSmart(getCtx: () => CompletionCtx) {
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", "_", " "],

    provideCompletionItems(model, position) {
      const ctx = getCtx();
      const range = getWordRange(model, position);
      const around = normalizeCtx(getContextText(model, position));

      const parsed = (() => {
        const dot = detectDotContext(around);
        const postTable = detectPostTableContext(around);
        const lastKw = lastKeyword(around);
        const { aliasMap, last, recentTables } = parseTablesAndAliases(around);
        return {
          dot,
          postTable,
          lastKeyword: lastKw,
          aliasMap,
          lastTable: last,
          recentTables,
        };
      })();

      const state = resolveState(parsed);

      /* ---------- DOT ---------- */
      if (state === "DOT" && parsed.dot) {
        if (parsed.dot.type === "aliasOrSchema") {
          const base = parsed.dot.base;
          const alias = parsed.aliasMap[base];
          if (alias) {
            return {
              suggestions:
                ctx.columnsByTable?.[
                  makeKey(alias.schema ?? ctx.activeSchema!, alias.table)
                ]?.map((c) => colItem(range, `${base}.${c}`)) ?? [],
            };
          }

          if (ctx.schemas.includes(base)) {
            return {
              suggestions: ctx.tables
                .filter((t) => t.schema === base)
                .map((t) => tableItem(range, t.name)),
            };
          }
        }
      }

      /* ---------- POST FROM ---------- */
      if (state === "POST_FROM_TABLE") {
        return {
          suggestions: POST_FROM_KW.map((k) => kw(range, k)),
        };
      }

      /* ---------- POST JOIN ---------- */
      if (state === "POST_JOIN_TABLE") {
        return {
          suggestions: POST_JOIN_KW.map((k) => kw(range, k)),
        };
      }

      /* ---------- EXPECT TABLE ---------- */
      if (state === "EXPECT_TABLE") {
        return {
          suggestions: ctx.tables.map((t) =>
            tableItem(
              range,
              t.schema === ctx.activeSchema ? t.name : `${t.schema}.${t.name}`
            )
          ),
        };
      }

      /* ---------- EXPECT COLUMN ---------- */
      if (state === "EXPECT_COLUMN") {
        const last = parsed.lastTable;
        const cols =
          last?.table && ctx.columnsByTable
            ? (ctx.columnsByTable[
                makeKey(last.schema ?? ctx.activeSchema!, last.table)
              ] ?? [])
            : [];

        return {
          suggestions: [
            ...cols.map((c) => colItem(range, c)),
            ...OPERATORS.map((o) => kw(range, o)),
            ...EXPR_KW.map((k) => kw(range, k)),
            ...FUNCTIONS.map((f) => kw(range, f)),
            ...KW_LIGHT.map((k) => kw(range, k)),
          ],
        };
      }

      /* ---------- DEFAULT ---------- */
      return {
        suggestions: KW_LIGHT.map((k) => kw(range, k)),
      };
    },
  });
}
