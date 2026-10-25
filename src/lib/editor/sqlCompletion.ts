import * as monaco from "monaco-editor";
import type { DatabaseEngine, TableItem } from "src/types";
import {
  getKeywordsForEngine,
  getFunctionsForEngine,
  ALL_COMPLETION_KEYWORDS,
} from "src/sqlConstants";
import { maskSql } from "./sqlLexer";
import { cursorScopes, type Scope } from "./sqlScope";
import { dialectFor, type SqlDialect } from "./sqlDialect";

/**
 * Smart SQL Completion - TablePlus-level
 *
 * Features:
 * - Engine-specific keywords and functions (PostgreSQL, MySQL, SQLite)
 * - Dialect-aware lexing and quoting (sqlLexer, sqlDialect)
 * - Multi-table column suggestions with alias awareness
 * - CTE (WITH clause) support
 * - INSERT INTO (columns), UPDATE SET context
 * - Smart sorting: recent tables, relevant columns first
 * - Safe handling of edge cases
 */

export type CompletionCtx = {
  schemas: string[];
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>; // key: schema.table
  engine?: DatabaseEngine;
};

type AliasRef = { schema?: string; table: string };

type TableRef = {
  schema?: string;
  table: string;
  alias?: string;
  /** The alias, else the table, as written ("U", [order], u). */
  written: string;
  /** The table name was quoted ("Users"). */
  tableQuoted: boolean;
};

type CteRef = {
  name: string;
  columns?: string[]; // extracted from SELECT if possible
};

type ParsedContext = {
  state: EditorState;
  /** Alias maps by scope, innermost first. */
  aliasMaps: Array<Map<string, AliasRef>>;
  recentTables: TableRef[];
  ctes: CteRef[];
  dotRef?: AliasRef;
  dotSchema?: string;
  dotTable?: string;
  insertTable?: string;
  updateTable?: string;
};

type EditorState =
  | "STATEMENT_START"
  | "DOT_ALIAS"
  | "DOT_SCHEMA"
  | "DOT_SCHEMA_TABLE"
  | "EXPECT_TABLE"
  | "EXPECT_COLUMN"
  | "POST_FROM"
  | "POST_JOIN"
  | "INSERT_COLUMNS"
  | "UPDATE_SET"
  | "SELECT_CLAUSE"
  | "ORDER_BY"
  | "GROUP_BY"
  | "DEFAULT";

/* =========================
 * Names as written
 * ========================= */

/** One identifier as written: "quoted", `quoted`, [quoted] or plain. */
const IDENT_PART = String.raw`(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[(?:[^\]]|\]\])*\]|[A-Za-z_][A-Za-z0-9_$]*)`;

function isQuoted(part: string): boolean {
  return /^["`[]/.test(part);
}

function unquoteIdent(part: string): string {
  if (part.startsWith('"') && part.endsWith('"')) {
    return part.slice(1, -1).replace(/""/g, '"');
  }
  if (part.startsWith("`") && part.endsWith("`")) {
    return part.slice(1, -1).replace(/``/g, "`");
  }
  if (part.startsWith("[") && part.endsWith("]")) {
    return part.slice(1, -1).replace(/\]\]/g, "]");
  }
  return part;
}

/** Blanks string literals and quoted names, so keywords inside them are ignored. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``");
}

/**
 * Alias map key: a quoted name matches exactly, an unquoted one in any case
 * (U and u).
 */
function refKey(name: string, quoted: boolean): string {
  return quoted ? `q:${name}` : `u:${name.toLowerCase()}`;
}

function lookupInScope(
  aliasMap: Map<string, AliasRef>,
  name: string,
  quoted: boolean
): AliasRef | undefined {
  if (quoted) {
    // "u" also names an unquoted alias u (folded to lower case).
    return (
      aliasMap.get(refKey(name, true)) ??
      (name === name.toLowerCase()
        ? aliasMap.get(refKey(name, false))
        : undefined)
    );
  }
  return (
    aliasMap.get(refKey(name, false)) ??
    aliasMap.get(refKey(name.toLowerCase(), true))
  );
}

/** The nearest scope's table a name refers to. */
function lookupRef(
  aliasMaps: Array<Map<string, AliasRef>>,
  name: string,
  quoted: boolean
): AliasRef | undefined {
  for (const aliasMap of aliasMaps) {
    const ref = lookupInScope(aliasMap, name, quoted);
    if (ref) return ref;
  }
  return undefined;
}

/**
 * The schema name `name` refers to: exact, else in any case for an unquoted
 * name.
 */
function findSchema(
  ctx: CompletionCtx,
  name: string,
  quoted = false
): string | undefined {
  return (
    ctx.schemas.find((schema) => schema === name) ??
    (quoted
      ? undefined
      : ctx.schemas.find(
          (schema) => schema.toLowerCase() === name.toLowerCase()
        ))
  );
}

/**
 * The columnsByTable key and schema of a table reference: an unqualified name
 * resolves among the known tables, preferring the active schema.
 */
function resolveTable(
  ctx: CompletionCtx,
  schema: string | undefined,
  table: string
): { key: string; schema: string; table: string } {
  const lower = table.toLowerCase();
  const matches = ctx.tables.filter(
    (t) =>
      (t.name === table || t.name.toLowerCase() === lower) &&
      (!schema ||
        t.schema === schema ||
        t.schema.toLowerCase() === schema.toLowerCase())
  );
  const pick =
    matches.find(
      (t) => t.name === table && t.schema === (schema ?? ctx.activeSchema)
    ) ??
    matches.find((t) => t.schema === (schema ?? ctx.activeSchema)) ??
    matches[0];
  if (pick) {
    return {
      key: `${pick.schema}.${pick.name}`,
      schema: pick.schema,
      table: pick.name,
    };
  }
  const fallbackSchema = schema ?? ctx.activeSchema ?? "public";
  return { key: `${fallbackSchema}.${table}`, schema: fallbackSchema, table };
}

function quoteIdent(ctx: CompletionCtx, name: string): string {
  return dialectFor(ctx.engine).quote(name);
}

function quotePath(ctx: CompletionCtx, ...parts: string[]): string {
  return parts.map((p) => quoteIdent(ctx, p)).join(".");
}

/* =========================
 * Parsing utilities
 * ========================= */

function getWordRange(
  model: monaco.editor.ITextModel,
  pos: monaco.Position
): monaco.Range {
  const word = model.getWordUntilPosition(pos);
  return new monaco.Range(
    pos.lineNumber,
    word.startColumn,
    pos.lineNumber,
    word.endColumn
  );
}

// Lex the whole buffer when it is not huge, so a literal or comment that
// starts far above the cursor and a statement end far below it are known;
// else a window around the cursor.
const LEX_WHOLE_BELOW = 200_000;
const MAX_BEFORE = 20_000;
const MAX_AFTER = 20_000;
// State detection looks at the end of the text before the cursor.
const MAX_STATE_CONTEXT = 1000;

type Statement = {
  /** The cursor's statement, masked (see maskSql). */
  text: string;
  /** `text` for finding keywords (see maskSql). */
  keywords: string;
  /** The cursor's offset in `text`. */
  cursor: number;
};

/**
 * The statement around the cursor, both sides of it, or null when the cursor
 * is in a string literal or a comment.
 */
function readStatement(
  model: monaco.editor.ITextModel,
  pos: monaco.Position,
  dialect: SqlDialect
): Statement | null {
  const value = model.getValue();
  const offset = model.getOffsetAt(pos);
  const whole = value.length <= LEX_WHOLE_BELOW;
  const start = whole ? 0 : Math.max(0, offset - MAX_BEFORE);
  const end = whole ? value.length : Math.min(value.length, offset + MAX_AFTER);
  const cursor = offset - start;
  const masked = maskSql(value.slice(start, end), dialect.lex, cursor);
  if (masked.cursorIn !== "code") return null;

  let from = 0;
  let to = masked.text.length;
  for (const at of masked.semicolons) {
    if (at < cursor) from = at + 1;
    else {
      to = at;
      break;
    }
  }
  return {
    text: masked.text.slice(from, to),
    keywords: masked.keywords.slice(from, to),
    cursor: cursor - from,
  };
}

function collapseSpaces(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const SPACE = /\s/;

/**
 * The text before the cursor that decides what to suggest: at most about
 * `max` characters, starting at a space outside quoted names, without the
 * word being typed ("FROM us" expects a table). Scans backwards, so a huge
 * statement costs no more than a short one.
 */
function stateContext(statement: Statement, max: number): string {
  const { text, keywords, cursor } = statement;
  let end = cursor;
  while (end > 0 && IDENT_CHAR.test(text[end - 1]!)) end--;
  let start = 0;
  if (end > max) {
    start = end - max;
    // keywords has spaces only between tokens, never inside quoted names.
    while (start < end && !SPACE.test(keywords[start]!)) start++;
  }
  return collapseSpaces(text.slice(start, end));
}

/**
 * Check if we're at statement boundary (after ; outside strings)
 */
function isStatementStart(ctx: string): boolean {
  const trimmed = ctx.trimEnd();
  if (!trimmed) return true;
  if (detectDotContext(trimmed)) return false;
  return findLastKeyword(trimmed) === "";
}

/**
 * Parse identifier (handles quoted and unquoted)
 */
function parseIdentifier(sql: string, start: number): [string, number] | null {
  let i = start;

  while (i < sql.length && /\s/.test(sql[i]!)) i++;

  if (i >= sql.length) return null;

  const ch = sql[i]!;

  // Double-quoted identifier
  if (ch === '"') {
    let end = i + 1;
    while (end < sql.length) {
      if (sql[end] === '"') {
        if (sql[end + 1] === '"') {
          end += 2;
          continue;
        }
        const name = sql.slice(i + 1, end).replace(/""/g, '"');
        return [name, end - start + 1];
      }
      end++;
    }
    return null;
  }

  // Backtick-quoted identifier (MySQL)
  if (ch === "`") {
    let end = i + 1;
    while (end < sql.length) {
      if (sql[end] === "`") {
        if (sql[end + 1] === "`") {
          end += 2;
          continue;
        }
        const name = sql.slice(i + 1, end).replace(/``/g, "`");
        return [name, end - start + 1];
      }
      end++;
    }
    return null;
  }

  // Bracket-quoted identifier (SQL Server style, also works in SQLite)
  if (ch === "[") {
    let end = i + 1;
    while (end < sql.length) {
      if (sql[end] === "]") {
        if (sql[end + 1] === "]") {
          end += 2;
          continue;
        }
        const name = sql.slice(i + 1, end).replace(/\]\]/g, "]");
        return [name, end - start + 1];
      }
      end++;
    }
    return null;
  }

  // Unquoted identifier
  if (/[a-zA-Z_]/.test(ch)) {
    let end = i + 1;
    while (end < sql.length && /[a-zA-Z0-9_]/.test(sql[end]!)) end++;
    return [sql.slice(i, end), end - start];
  }

  return null;
}

/**
 * Parse table reference: [schema.]table [AS] [alias]
 */
function parseTableRef(sql: string, start: number): [TableRef, number] | null {
  let i = start;

  while (i < sql.length && /\s/.test(sql[i]!)) i++;

  const first = parseIdentifier(sql, i);
  if (!first) return null;

  let tableAt = i;
  i += first[1];

  while (i < sql.length && /\s/.test(sql[i]!)) i++;

  let schema: string | undefined;
  let table: string;

  if (sql[i] === ".") {
    schema = first[0];
    i++;
    const second = parseIdentifier(sql, i);
    if (!second) return null;
    table = second[0];
    tableAt = i;
    i += second[1];
  } else {
    table = first[0];
  }

  while (i < sql.length && /\s/.test(sql[i]!)) i++;

  let alias: string | undefined;
  let written = sql.slice(tableAt, i).trim();
  const tableQuoted = isQuoted(written);

  // Skip AS keyword if present
  if (/^AS\s/i.test(sql.slice(i, i + 3))) {
    i += 3;
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
  }

  const maybeAlias = parseIdentifier(sql, i);
  if (maybeAlias) {
    const upper = maybeAlias[0].toUpperCase();
    const reserved = [
      "WHERE",
      "JOIN",
      "LEFT",
      "RIGHT",
      "INNER",
      "FULL",
      "CROSS",
      "ON",
      "GROUP",
      "ORDER",
      "LIMIT",
      "OFFSET",
      "HAVING",
      "UNION",
      "SET",
      "VALUES",
      "RETURNING",
      "FETCH",
      "NATURAL",
      "USING",
      "LATERAL",
      "WINDOW",
      "EXCEPT",
      "INTERSECT",
      "FOR",
    ];
    const aliasText = sql.slice(i, i + maybeAlias[1]).trim();
    // A quoted alias can be any word ("order").
    if (isQuoted(aliasText) || !reserved.includes(upper)) {
      alias = maybeAlias[0];
      written = aliasText;
      i += maybeAlias[1];
    }
  }

  return [{ schema, table, alias, written, tableQuoted }, i - start];
}

/**
 * Extract all table references of a scope. Keywords are found in its keyword
 * view, names read from its text (see maskSql). Alias keys come from refKey.
 */
function extractTableRefs(scope: Scope): {
  tables: TableRef[];
  aliasMap: Map<string, AliasRef>;
} {
  const tables: TableRef[] = [];
  const aliasMap = new Map<string, AliasRef>();
  const add = (tableRef: TableRef) => {
    tables.push(tableRef);
    const ref = { schema: tableRef.schema, table: tableRef.table };
    if (tableRef.alias) {
      aliasMap.set(refKey(tableRef.alias, isQuoted(tableRef.written)), ref);
    }
    aliasMap.set(refKey(tableRef.table, tableRef.tableQuoted), ref);
  };

  const re =
    /\b(FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN)\s+/gi;
  const ctx = scope.text;
  let match: RegExpExecArray | null;

  while ((match = re.exec(scope.keywords)) !== null) {
    let at = match.index + match[0].length;
    // FROM a, b c, d: every table of the list.
    for (;;) {
      const ref = parseTableRef(ctx, at);
      if (!ref) break;
      add(ref[0]);
      at += ref[1];
      let next = at;
      while (next < ctx.length && /\s/.test(ctx[next]!)) next++;
      if (ctx[next] !== ",") break;
      at = next + 1;
    }
  }

  return { tables, aliasMap };
}

/**
 * Extract CTEs from WITH clause
 */
function extractCtes(ctx: string): CteRef[] {
  const ctes: CteRef[] = [];
  const upper = ctx.toUpperCase();

  const withIdx = upper.indexOf("WITH ");
  if (withIdx === -1) return ctes;

  const re = /\bWITH\s+(\w+)\s+AS\s*\(/gi;
  re.lastIndex = withIdx;

  let match: RegExpExecArray | null;
  while ((match = re.exec(ctx)) !== null) {
    ctes.push({ name: match[1] });

    const afterParen = ctx.indexOf(")", match.index + match[0].length);
    if (afterParen !== -1) {
      const afterClose = ctx
        .slice(afterParen + 1)
        .match(/^\s*,\s*(\w+)\s+AS\s*\(/i);
      if (afterClose) {
        ctes.push({ name: afterClose[1] });
      }
    }
  }

  return ctes;
}

/**
 * Detect dot context for completion: `a.`, `schema.table.`, `"Quoted".`,
 * with an optional partial name after the last dot. Parts are unquoted,
 * with whether they were quoted.
 */
const DOT_CONTEXT_RE = new RegExp(
  `(${IDENT_PART}(?:\\s*\\.\\s*${IDENT_PART})*)\\s*\\.\\s*(?:[A-Za-z_][A-Za-z0-9_$]*)?$`
);
const IDENT_PART_RE = new RegExp(IDENT_PART, "g");

type DotPart = { name: string; quoted: boolean };

function detectDotContext(ctx: string): DotPart[] | null {
  const match = ctx.match(DOT_CONTEXT_RE);
  if (!match) return null;
  const parts = (match[1]!.match(IDENT_PART_RE) ?? []).map((part) => ({
    name: unquoteIdent(part),
    quoted: isQuoted(part),
  }));
  return parts.length ? parts : null;
}

/**
 * Detect INSERT INTO table (|) context
 */
function detectInsertContext(ctx: string): string | null {
  const match = ctx.match(
    /\bINSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\([^)]*$/i
  );
  return match ? match[1].split(".").pop()! : null;
}

/**
 * Detect UPDATE table SET context
 */
function detectUpdateContext(ctx: string): string | null {
  const match = ctx.match(
    /\bUPDATE\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+SET(?:\s+|$)/i
  );
  return match ? match[1].split(".").pop()! : null;
}

/**
 * Find the last significant keyword: whole words only (not ON inside
 * "reason"), outside strings and quoted names.
 */
const LAST_KEYWORD_RE =
  /\b(LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|GROUP\s+BY|ORDER\s+BY|SELECT|FROM|WHERE|JOIN|ON|AND|OR|HAVING|SET|VALUES|INSERT|UPDATE|DELETE)\b/gi;

function findLastKeyword(ctx: string): string {
  let last = "";
  for (const match of stripLiterals(ctx).matchAll(LAST_KEYWORD_RE)) {
    last = match[1]!.toUpperCase().replace(/\s+/g, " ");
  }
  return last;
}

/**
 * Detect post-table context: the statement ends right after a FROM/JOIN table
 * list (`FROM users u`), not after a clause keyword (`FROM users WHERE`).
 */
const TABLE_REF_SRC = `${IDENT_PART}(?:\\s*\\.\\s*${IDENT_PART})?(?:\\s+(?:AS\\s+)?${IDENT_PART})?`;
const POST_FROM_RE = new RegExp(
  `\\bFROM\\s+${TABLE_REF_SRC}(?:\\s*,\\s*${TABLE_REF_SRC})*$`,
  "i"
);
const POST_JOIN_RE = new RegExp(
  `\\b(?:LEFT\\s+|RIGHT\\s+|INNER\\s+|FULL\\s+|CROSS\\s+)?JOIN\\s+${TABLE_REF_SRC}$`,
  "i"
);
const CLAUSE_WORDS = new Set([
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "FULL",
  "CROSS",
  "ON",
  "GROUP",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "HAVING",
  "UNION",
  "SET",
  "VALUES",
  "RETURNING",
  "FETCH",
  "NATURAL",
  "USING",
  "LATERAL",
  "WINDOW",
  "EXCEPT",
  "INTERSECT",
  "FOR",
  "AS",
  "BY",
  "AND",
  "OR",
  "NOT",
  "SELECT",
  "FROM",
]);

function detectPostTableContext(ctx: string): "FROM" | "JOIN" | null {
  const trimmed = ctx.trimEnd();
  const lastWord = trimmed.match(/([A-Za-z_]+)$/)?.[1]?.toUpperCase();
  // A clause keyword typed after the table starts that clause.
  if (lastWord && CLAUSE_WORDS.has(lastWord)) return null;
  if (POST_JOIN_RE.test(trimmed)) return "JOIN";
  if (POST_FROM_RE.test(trimmed)) return "FROM";
  return null;
}

/**
 * Main context parser. `statement` is masked (see maskSql) and `cursor` is
 * the cursor's offset in it.
 */
function parseContext(
  statement: Statement,
  completionCtx: CompletionCtx
): ParsedContext {
  const ctx = stateContext(statement, MAX_STATE_CONTEXT);

  // Names refer to the tables of the cursor's own query, which may be named
  // after the cursor (SELECT | FROM users), and of the queries around it; the
  // innermost wins.
  const scopes = cursorScopes(
    statement.text,
    statement.keywords,
    statement.cursor
  ).map(extractTableRefs);
  const tables = scopes[scopes.length - 1]?.tables ?? [];
  const aliasMaps = scopes.map((scope) => scope.aliasMap).reverse();
  const ctes = extractCtes(collapseSpaces(statement.keywords));

  const statementMap = aliasMaps[aliasMaps.length - 1]!;
  for (const cte of ctes) {
    if (!statementMap.has(refKey(cte.name, false))) {
      statementMap.set(refKey(cte.name, false), { table: cte.name });
    }
  }

  const result: ParsedContext = {
    state: "DEFAULT",
    aliasMaps,
    recentTables: tables.slice(-5),
    ctes,
  };

  if (isStatementStart(ctx)) {
    result.state = "STATEMENT_START";
    return result;
  }

  const dot = detectDotContext(ctx);
  if (dot) {
    const base = dot[0]!;
    const dotRef =
      dot.length === 1
        ? lookupRef(aliasMaps, base.name, base.quoted)
        : undefined;
    if (dotRef) {
      result.state = "DOT_ALIAS";
      result.dotRef = dotRef;
      return result;
    }

    const dotSchema = findSchema(completionCtx, base.name, base.quoted);
    if (dot.length === 1 && dotSchema) {
      result.state = "DOT_SCHEMA";
      result.dotSchema = dotSchema;
      return result;
    }

    if (dot.length === 2 && dotSchema) {
      result.state = "DOT_SCHEMA_TABLE";
      result.dotSchema = dotSchema;
      result.dotTable = dot[1]!.name;
      return result;
    }
  }

  const insertTable = detectInsertContext(ctx);
  if (insertTable) {
    result.state = "INSERT_COLUMNS";
    result.insertTable = insertTable;
    return result;
  }

  const updateTable = detectUpdateContext(ctx);
  if (updateTable) {
    result.state = "UPDATE_SET";
    result.updateTable = updateTable;
    return result;
  }

  const postTable = detectPostTableContext(ctx);
  if (postTable === "FROM") {
    result.state = "POST_FROM";
    return result;
  }
  if (postTable === "JOIN") {
    result.state = "POST_JOIN";
    return result;
  }

  const lastKw = findLastKeyword(ctx);

  if (lastKw === "FROM" || lastKw === "JOIN" || lastKw.includes("JOIN")) {
    // After FROM a, b ... the next name is a table too.
    result.state = "EXPECT_TABLE";
    return result;
  }

  if (lastKw === "SELECT") {
    result.state = "SELECT_CLAUSE";
    return result;
  }

  if (lastKw === "ORDER BY") {
    result.state = "ORDER_BY";
    return result;
  }

  if (lastKw === "GROUP BY") {
    result.state = "GROUP_BY";
    return result;
  }

  if (["WHERE", "ON", "AND", "OR", "HAVING", "SET"].includes(lastKw)) {
    result.state = "EXPECT_COLUMN";
    return result;
  }

  return result;
}

/* =========================
 * Completion item builders
 * ========================= */

type Priority = 0 | 1 | 2 | 3 | 4 | 5;

function sortText(priority: Priority, label: string): string {
  return `${priority}${label.toLowerCase()}`;
}

function keywordItem(
  range: monaco.Range,
  kw: string,
  priority: Priority = 3
): monaco.languages.CompletionItem {
  return {
    label: kw,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: kw,
    sortText: sortText(priority, kw),
    range,
  };
}

function tableItem(
  range: monaco.Range,
  table: TableItem,
  ctx: CompletionCtx,
  priority: Priority = 2,
  /** Prefix the schema when it is not the active one (not after `schema.`). */
  qualify = true
): monaco.languages.CompletionItem {
  const isSameSchema = table.schema === ctx.activeSchema;
  const insertText =
    isSameSchema || !qualify
      ? quoteIdent(ctx, table.name)
      : quotePath(ctx, table.schema, table.name);

  const kind =
    (table as any).kind === "view"
      ? monaco.languages.CompletionItemKind.Class
      : monaco.languages.CompletionItemKind.Struct;

  const isView = (table as any).kind === "view";

  return {
    label: table.name,
    kind,
    insertText,
    sortText: sortText(priority, table.name),
    detail: `${table.schema}${isView ? " (view)" : ""}`,
    range,
  };
}

function columnItem(
  range: monaco.Range,
  column: string,
  ctx: CompletionCtx,
  tableHint?: string,
  schemaHint?: string,
  priority: Priority = 1
): monaco.languages.CompletionItem {
  const detail =
    schemaHint && tableHint ? `${schemaHint}.${tableHint}` : tableHint;

  return {
    label: column,
    kind: monaco.languages.CompletionItemKind.Field,
    insertText: quoteIdent(ctx, column),
    sortText: sortText(priority, column),
    detail,
    range,
  };
}

function prefixedColumnItem(
  range: monaco.Range,
  column: string,
  prefix: string,
  ctx: CompletionCtx,
  tableHint?: string,
  schemaHint?: string,
  priority: Priority = 1
): monaco.languages.CompletionItem {
  const label = `${prefix}.${column}`;
  const detail =
    schemaHint && tableHint ? `${schemaHint}.${tableHint}` : tableHint;

  return {
    label,
    kind: monaco.languages.CompletionItemKind.Field,
    insertText: `${prefix}.${quoteIdent(ctx, column)}`,
    filterText: column,
    sortText: sortText(priority, column),
    detail,
    range,
  };
}

function cteItem(
  range: monaco.Range,
  cte: CteRef,
  priority: Priority = 1
): monaco.languages.CompletionItem {
  return {
    label: cte.name,
    kind: monaco.languages.CompletionItemKind.Module,
    insertText: cte.name,
    sortText: sortText(priority, cte.name),
    detail: "CTE",
    range,
  };
}

function functionItem(
  range: monaco.Range,
  fn: string,
  priority: Priority = 4
): monaco.languages.CompletionItem {
  return {
    label: fn,
    kind: monaco.languages.CompletionItemKind.Function,
    insertText: `${fn}($0)`,
    insertTextRules:
      monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    sortText: sortText(priority, fn),
    range,
  };
}

/* =========================
 * Main completion provider
 * ========================= */

export function registerSqlCompletionSmart(
  getCtx: () => CompletionCtx
): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " ", "(", ","],

    provideCompletionItems(model, position) {
      const ctx = getCtx();
      const range = getWordRange(model, position);
      const statement = readStatement(model, position, dialectFor(ctx.engine));
      // Nothing to suggest inside a string literal or a comment.
      if (!statement) return { suggestions: [] };
      const parsed = parseContext(statement, ctx);

      const suggestions: monaco.languages.CompletionItem[] = [];

      // Get engine-specific keywords and functions
      const KEYWORDS = getKeywordsForEngine(ctx.engine);
      const FUNCTIONS = getFunctionsForEngine(ctx.engine);

      /* ---------- STATEMENT_START ---------- */
      if (parsed.state === "STATEMENT_START") {
        KEYWORDS.statement.forEach((kw) =>
          suggestions.push(keywordItem(range, kw, 0))
        );
        return { suggestions };
      }

      /* ---------- DOT_ALIAS (alias.column) ---------- */
      if (parsed.state === "DOT_ALIAS" && parsed.dotRef) {
        const ref = parsed.dotRef;
        const resolved = resolveTable(ctx, ref.schema, ref.table);
        const columns = ctx.columnsByTable?.[resolved.key] ?? [];

        columns.forEach((col) => {
          suggestions.push(
            columnItem(range, col, ctx, resolved.table, resolved.schema, 0)
          );
        });
        return { suggestions };
      }

      /* ---------- DOT_SCHEMA (schema.table) ---------- */
      if (parsed.state === "DOT_SCHEMA" && parsed.dotSchema) {
        const schema = parsed.dotSchema;
        // The schema is already written: insert only the table name.
        ctx.tables
          .filter((t) => t.schema === schema)
          .forEach((t) => {
            suggestions.push(tableItem(range, t, ctx, 0, false));
          });
        return { suggestions };
      }

      /* ---------- DOT_SCHEMA_TABLE (schema.table.column) ---------- */
      if (
        parsed.state === "DOT_SCHEMA_TABLE" &&
        parsed.dotSchema &&
        parsed.dotTable
      ) {
        const resolved = resolveTable(ctx, parsed.dotSchema, parsed.dotTable);
        const columns = ctx.columnsByTable?.[resolved.key] ?? [];

        columns.forEach((col) => {
          suggestions.push(
            columnItem(range, col, ctx, resolved.table, resolved.schema, 0)
          );
        });
        return { suggestions };
      }

      /* ---------- EXPECT_TABLE ---------- */
      if (parsed.state === "EXPECT_TABLE") {
        parsed.ctes.forEach((cte) => {
          suggestions.push(cteItem(range, cte, 0));
        });

        const recentTableNames = new Set(
          parsed.recentTables.map((t) => t.table)
        );

        ctx.tables.forEach((t) => {
          const priority: Priority = recentTableNames.has(t.name) ? 1 : 2;
          suggestions.push(tableItem(range, t, ctx, priority));
        });

        return { suggestions };
      }

      /* ---------- POST_FROM ---------- */
      if (parsed.state === "POST_FROM") {
        KEYWORDS.postFrom.forEach((kw) =>
          suggestions.push(keywordItem(range, kw, 0))
        );
        return { suggestions };
      }

      /* ---------- POST_JOIN ---------- */
      if (parsed.state === "POST_JOIN") {
        KEYWORDS.postJoin.forEach((kw) =>
          suggestions.push(keywordItem(range, kw, 0))
        );
        return { suggestions };
      }

      /* ---------- INSERT_COLUMNS ---------- */
      if (parsed.state === "INSERT_COLUMNS" && parsed.insertTable) {
        const table = ctx.tables.find(
          (t) => t.name.toLowerCase() === parsed.insertTable!.toLowerCase()
        );
        if (table) {
          const columns =
            ctx.columnsByTable?.[`${table.schema}.${table.name}`] ?? [];

          columns.forEach((col) => {
            suggestions.push(
              columnItem(range, col, ctx, table.name, table.schema, 0)
            );
          });
        }
        return { suggestions };
      }

      /* ---------- UPDATE_SET ---------- */
      if (parsed.state === "UPDATE_SET" && parsed.updateTable) {
        const table = ctx.tables.find(
          (t) => t.name.toLowerCase() === parsed.updateTable!.toLowerCase()
        );
        if (table) {
          const columns =
            ctx.columnsByTable?.[`${table.schema}.${table.name}`] ?? [];

          columns.forEach((col) => {
            suggestions.push(
              columnItem(range, col, ctx, table.name, table.schema, 0)
            );
          });
        }

        KEYWORDS.expression.forEach((kw) =>
          suggestions.push(keywordItem(range, kw, 3))
        );

        return { suggestions };
      }

      /* ---------- SELECT_CLAUSE ---------- */
      if (parsed.state === "SELECT_CLAUSE") {
        const addedColumns = new Set<string>();

        parsed.recentTables.forEach((t) => {
          const resolved = resolveTable(ctx, t.schema, t.table);
          const schema = resolved.schema;
          const columns = ctx.columnsByTable?.[resolved.key] ?? [];
          // The alias or table as written in the statement.
          const prefix = t.written;

          columns.forEach((col) => {
            if (!addedColumns.has(col)) {
              suggestions.push(columnItem(range, col, ctx, t.table, schema, 0));
              addedColumns.add(col);
            }

            if (parsed.recentTables.length > 1) {
              suggestions.push(
                prefixedColumnItem(range, col, prefix, ctx, t.table, schema, 1)
              );
            }
          });
        });

        suggestions.push({
          label: "*",
          kind: monaco.languages.CompletionItemKind.Operator,
          insertText: "*",
          sortText: sortText(0, "*"),
          range,
        });

        FUNCTIONS.forEach((fn) => suggestions.push(functionItem(range, fn, 2)));

        KEYWORDS.clause.forEach((kw) =>
          suggestions.push(keywordItem(range, kw, 4))
        );

        return { suggestions };
      }

      /* ---------- ORDER_BY / GROUP_BY ---------- */
      if (parsed.state === "ORDER_BY" || parsed.state === "GROUP_BY") {
        parsed.recentTables.forEach((t) => {
          const resolved = resolveTable(ctx, t.schema, t.table);
          const schema = resolved.schema;
          const columns = ctx.columnsByTable?.[resolved.key] ?? [];
          // The alias or table as written in the statement.
          const prefix = t.written;

          columns.forEach((col) => {
            suggestions.push(columnItem(range, col, ctx, t.table, schema, 0));

            if (parsed.recentTables.length > 1) {
              suggestions.push(
                prefixedColumnItem(range, col, prefix, ctx, t.table, schema, 1)
              );
            }
          });
        });

        if (parsed.state === "ORDER_BY") {
          KEYWORDS.orderBy.forEach((kw) =>
            suggestions.push(keywordItem(range, kw, 2))
          );
        }

        return { suggestions };
      }

      /* ---------- EXPECT_COLUMN (WHERE, ON, AND, OR) ---------- */
      if (parsed.state === "EXPECT_COLUMN") {
        parsed.recentTables.forEach((t) => {
          const resolved = resolveTable(ctx, t.schema, t.table);
          const schema = resolved.schema;
          const columns = ctx.columnsByTable?.[resolved.key] ?? [];
          // The alias or table as written in the statement.
          const prefix = t.written;

          columns.forEach((col) => {
            suggestions.push(columnItem(range, col, ctx, t.table, schema, 0));
            suggestions.push(
              prefixedColumnItem(range, col, prefix, ctx, t.table, schema, 1)
            );
          });
        });

        KEYWORDS.expression.forEach((kw) =>
          suggestions.push(keywordItem(range, kw, 2))
        );
        FUNCTIONS.forEach((fn) => suggestions.push(functionItem(range, fn, 3)));
        KEYWORDS.values.forEach((v) =>
          suggestions.push(keywordItem(range, v, 3))
        );

        return { suggestions };
      }

      /* ---------- DEFAULT ---------- */
      ALL_COMPLETION_KEYWORDS.forEach((kw) =>
        suggestions.push(keywordItem(range, kw, 2))
      );

      return { suggestions };
    },
  });
}
