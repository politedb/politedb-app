import * as monaco from "monaco-editor";
import type { DatabaseEngine, TableItem } from "src/types";
import {
  getKeywordsForEngine,
  getFunctionsForEngine,
  ALL_COMPLETION_KEYWORDS,
} from "src/sqlConstants";

/**
 * Smart SQL Completion - TablePlus-level
 *
 * Features:
 * - Engine-specific keywords and functions (PostgreSQL, MySQL, SQLite)
 * - Quoted identifier support (PostgreSQL "", MySQL ``)
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
};

type CteRef = {
  name: string;
  columns?: string[]; // extracted from SELECT if possible
};

type ParsedContext = {
  state: EditorState;
  aliasMap: Map<string, AliasRef>;
  recentTables: TableRef[];
  ctes: CteRef[];
  dotBase?: string;
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
 * Engine-specific quoting
 * ========================= */

function isPg(ctx: CompletionCtx): boolean {
  return !ctx.engine || ctx.engine === "postgres";
}

function isMySql(ctx: CompletionCtx): boolean {
  return ctx.engine === "mysql" || ctx.engine === "mariadb";
}

function isSqlite(ctx: CompletionCtx): boolean {
  return ctx.engine === "sqlite" || ctx.engine === "d1";
}

const PG_SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
const MYSQL_SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteIdentPg(name: string): string {
  if (!name) return name;
  if (name.startsWith('"') && name.endsWith('"')) return name;
  if (PG_SAFE_IDENT.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteIdentMySql(name: string): string {
  if (!name) return name;
  if (name.startsWith("`") && name.endsWith("`")) return name;
  if (MYSQL_SAFE_IDENT.test(name)) return name;
  return `\`${name.replace(/`/g, "``")}\``;
}

function quoteIdent(ctx: CompletionCtx, name: string): string {
  if (isPg(ctx) || isSqlite(ctx)) return quoteIdentPg(name);
  if (isMySql(ctx)) return quoteIdentMySql(name);
  return name;
}

function quotePath(ctx: CompletionCtx, ...parts: string[]): string {
  return parts.map((p) => quoteIdent(ctx, p)).join(".");
}

/* =========================
 * Parsing utilities
 * ========================= */

function makeKey(
  schema: string | undefined,
  table: string,
  defaultSchema = "public"
): string {
  return `${schema ?? defaultSchema}.${table}`;
}

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

function getContextText(
  model: monaco.editor.ITextModel,
  pos: monaco.Position,
  maxChars = 500
): string {
  const offset = model.getOffsetAt(pos);
  const start = Math.max(0, offset - maxChars);
  return model.getValue().slice(start, offset);
}

/**
 * Remove comments and normalize whitespace, preserving string contents
 */
function normalizeContext(sql: string): string {
  let result = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";

    // Line comment
    if (!inSingle && !inDouble && !inBacktick && ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      result += " ";
      continue;
    }

    // Block comment
    if (!inSingle && !inDouble && !inBacktick && ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      result += " ";
      continue;
    }

    // MySQL # comment
    if (!inSingle && !inDouble && !inBacktick && ch === "#") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      result += " ";
      continue;
    }

    // String/identifier tracking
    if (ch === "'" && !inDouble && !inBacktick) {
      if (inSingle && next === "'") {
        result += "''";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !inBacktick) {
      if (inDouble && next === '"') {
        result += '""';
        i += 2;
        continue;
      }
      inDouble = !inDouble;
    } else if (ch === "`" && !inSingle && !inDouble) {
      if (inBacktick && next === "`") {
        result += "``";
        i += 2;
        continue;
      }
      inBacktick = !inBacktick;
    }

    // Normalize whitespace outside strings
    if (!inSingle && !inDouble && !inBacktick && /\s/.test(ch)) {
      if (!result.endsWith(" ")) result += " ";
    } else {
      result += ch;
    }

    i++;
  }

  return result.trim();
}

/**
 * Check if we're at statement boundary (after ; outside strings)
 */
function isStatementStart(ctx: string): boolean {
  const trimmed = ctx.trimEnd();
  if (!trimmed) return true;

  const lastSemi = trimmed.lastIndexOf(";");
  if (lastSemi === -1) return false;

  const after = trimmed.slice(lastSemi + 1).trim();
  return after === "";
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
    const end = sql.indexOf("]", i + 1);
    if (end === -1) return null;
    const name = sql.slice(i + 1, end);
    return [name, end - start + 1];
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
    i += second[1];
  } else {
    table = first[0];
  }

  while (i < sql.length && /\s/.test(sql[i]!)) i++;

  let alias: string | undefined;

  // Skip AS keyword if present
  if (sql.slice(i, i + 3).toUpperCase() === "AS ") {
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
    ];
    if (!reserved.includes(upper)) {
      alias = maybeAlias[0];
      i += maybeAlias[1];
    }
  }

  return [{ schema, table, alias }, i - start];
}

/**
 * Extract all table references from context
 */
function extractTableRefs(ctx: string): {
  tables: TableRef[];
  aliasMap: Map<string, AliasRef>;
} {
  const tables: TableRef[] = [];
  const aliasMap = new Map<string, AliasRef>();

  const re =
    /\b(FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN)\s+/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(ctx)) !== null) {
    const ref = parseTableRef(ctx, match.index + match[0].length);
    if (ref) {
      const [tableRef] = ref;
      tables.push(tableRef);

      if (tableRef.alias) {
        aliasMap.set(tableRef.alias, {
          schema: tableRef.schema,
          table: tableRef.table,
        });
      }

      aliasMap.set(tableRef.table, {
        schema: tableRef.schema,
        table: tableRef.table,
      });
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
 * Detect dot context for completion
 */
function detectDotContext(
  ctx: string
): { base: string; parts: string[] } | null {
  const match = ctx.match(
    /([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\.\s*([a-zA-Z_][a-zA-Z0-9_]*)?\s*$/
  );

  if (!match) return null;

  const full = match[1];
  const parts = full.split(".");

  return { base: parts[0], parts };
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
  const match = ctx.match(/\bUPDATE\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+SET\s+/i);
  return match ? match[1].split(".").pop()! : null;
}

/**
 * Find the last significant keyword
 */
function findLastKeyword(ctx: string): string {
  const upper = ctx.toUpperCase();
  const keywords = [
    "SELECT",
    "FROM",
    "WHERE",
    "JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "ON",
    "AND",
    "OR",
    "GROUP BY",
    "ORDER BY",
    "HAVING",
    "SET",
    "VALUES",
    "INSERT",
    "UPDATE",
    "DELETE",
  ];

  let lastKw = "";
  let lastIdx = -1;

  for (const kw of keywords) {
    const idx = upper.lastIndexOf(kw);
    if (idx > lastIdx) {
      lastIdx = idx;
      lastKw = kw;
    }
  }

  return lastKw;
}

/**
 * Detect post-table context
 */
function detectPostTableContext(ctx: string): "FROM" | "JOIN" | null {
  const trimmed = ctx.trimEnd();

  const fromMatch = trimmed.match(
    /\bFROM\s+[a-zA-Z_][a-zA-Z0-9_."`\[\]]*(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?\s*$/i
  );
  if (fromMatch) return "FROM";

  const joinMatch = trimmed.match(
    /\b(?:LEFT\s+|RIGHT\s+|INNER\s+|FULL\s+|CROSS\s+)?JOIN\s+[a-zA-Z_][a-zA-Z0-9_."`\[\]]*(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?\s*$/i
  );
  if (joinMatch) return "JOIN";

  return null;
}

/**
 * Main context parser
 */
function parseContext(
  rawCtx: string,
  completionCtx: CompletionCtx
): ParsedContext {
  const ctx = normalizeContext(rawCtx);
  const { tables, aliasMap } = extractTableRefs(ctx);
  const ctes = extractCtes(ctx);

  for (const cte of ctes) {
    aliasMap.set(cte.name, { table: cte.name });
  }

  const result: ParsedContext = {
    state: "DEFAULT",
    aliasMap,
    recentTables: tables.slice(-5),
    ctes,
  };

  if (isStatementStart(ctx)) {
    result.state = "STATEMENT_START";
    return result;
  }

  const dot = detectDotContext(ctx);
  if (dot) {
    result.dotBase = dot.base;

    if (aliasMap.has(dot.base)) {
      result.state = "DOT_ALIAS";
      return result;
    }

    if (completionCtx.schemas.includes(dot.base)) {
      result.state = "DOT_SCHEMA";
      result.dotSchema = dot.base;
      return result;
    }

    if (dot.parts.length === 2) {
      const schema = dot.parts[0];
      const table = dot.parts[1];
      if (completionCtx.schemas.includes(schema)) {
        result.state = "DOT_SCHEMA_TABLE";
        result.dotSchema = schema;
        result.dotTable = table;
        return result;
      }
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
  priority: Priority = 2
): monaco.languages.CompletionItem {
  const isSameSchema = table.schema === ctx.activeSchema;
  const insertText = isSameSchema
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
    insertText: `${quoteIdent(ctx, prefix)}.${quoteIdent(ctx, column)}`,
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
      const rawContext = getContextText(model, position);
      const parsed = parseContext(rawContext, ctx);

      const suggestions: monaco.languages.CompletionItem[] = [];
      const defaultSchema = ctx.activeSchema ?? "public";

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
      if (parsed.state === "DOT_ALIAS" && parsed.dotBase) {
        const ref = parsed.aliasMap.get(parsed.dotBase);
        if (ref) {
          const schema = ref.schema ?? defaultSchema;
          const key = makeKey(ref.schema, ref.table, defaultSchema);
          const columns = ctx.columnsByTable?.[key] ?? [];

          columns.forEach((col) => {
            suggestions.push(columnItem(range, col, ctx, ref.table, schema, 0));
          });
        }
        return { suggestions };
      }

      /* ---------- DOT_SCHEMA (schema.table) ---------- */
      if (parsed.state === "DOT_SCHEMA" && parsed.dotSchema) {
        const schema = parsed.dotSchema;
        ctx.tables
          .filter((t) => t.schema === schema)
          .forEach((t) => {
            suggestions.push(tableItem(range, t, ctx, 0));
          });
        return { suggestions };
      }

      /* ---------- DOT_SCHEMA_TABLE (schema.table.column) ---------- */
      if (
        parsed.state === "DOT_SCHEMA_TABLE" &&
        parsed.dotSchema &&
        parsed.dotTable
      ) {
        const key = makeKey(parsed.dotSchema, parsed.dotTable, defaultSchema);
        const columns = ctx.columnsByTable?.[key] ?? [];

        columns.forEach((col) => {
          suggestions.push(
            columnItem(range, col, ctx, parsed.dotTable, parsed.dotSchema, 0)
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
          const key = makeKey(table.schema, table.name, defaultSchema);
          const columns = ctx.columnsByTable?.[key] ?? [];

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
          const key = makeKey(table.schema, table.name, defaultSchema);
          const columns = ctx.columnsByTable?.[key] ?? [];

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
          const schema = t.schema ?? defaultSchema;
          const key = makeKey(t.schema, t.table, defaultSchema);
          const columns = ctx.columnsByTable?.[key] ?? [];
          const prefix = t.alias ?? t.table;

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
          const schema = t.schema ?? defaultSchema;
          const key = makeKey(t.schema, t.table, defaultSchema);
          const columns = ctx.columnsByTable?.[key] ?? [];
          const prefix = t.alias ?? t.table;

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
          const schema = t.schema ?? defaultSchema;
          const key = makeKey(t.schema, t.table, defaultSchema);
          const columns = ctx.columnsByTable?.[key] ?? [];
          const prefix = t.alias ?? t.table;

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
