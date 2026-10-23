/**
 * A small PostgreSQL lexer for statement checks before EXPLAIN: what the
 * first keyword is, whether positional parameters ($1) appear, and where
 * statements end. It follows PostgreSQL's lexical rules where they matter for
 * these checks: nested block comments, '' and E'\'' escapes, quoted
 * identifiers, dollar quotes ($tag$, tags may contain digits after the first
 * character) and identifiers that contain $.
 *
 * Not a parser: callers must refuse when `unterminated` is set.
 */

export type PgTokenKind =
  | "word"
  | "string"
  | "identifier"
  | "comment"
  | "param"
  | "semicolon"
  | "other";

export type PgToken = { kind: PgTokenKind; start: number; end: number };

export type PgLexResult = {
  tokens: PgToken[];
  /** A string, quoted identifier, dollar quote or comment never closed. */
  unterminated: boolean;
};

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export function lexPostgres(sql: string): PgLexResult {
  const tokens: PgToken[] = [];
  const n = sql.length;
  let i = 0;
  let unterminated = false;

  const push = (kind: PgTokenKind, start: number, end: number) =>
    tokens.push({ kind, start, end });

  /** Single-quoted body from `i` (at the opening quote). */
  const quoted = (quote: string, backslashEscapes: boolean) => {
    let j = i + 1;
    while (j < n) {
      const ch = sql[j]!;
      if (backslashEscapes && ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) {
        if (sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    unterminated = true;
    return n;
  };

  while (i < n) {
    const ch = sql[i]!;
    const start = i;
    if (/\s/.test(ch)) {
      i++;
    } else if (sql.startsWith("--", i)) {
      while (i < n && sql[i] !== "\n") i++;
      push("comment", start, i);
    } else if (sql.startsWith("/*", i)) {
      let depth = 0;
      while (i < n) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      if (depth !== 0) unterminated = true;
      push("comment", start, i);
    } else if ((ch === "E" || ch === "e") && sql[i + 1] === "'") {
      i++;
      i = quoted("'", true);
      push("string", start, i);
    } else if (ch === "'") {
      i = quoted("'", false);
      push("string", start, i);
    } else if (ch === '"') {
      i = quoted('"', false);
      push("identifier", start, i);
    } else if (ch === "$") {
      const tag = sql.slice(i).match(DOLLAR_TAG)?.[0];
      const param = sql.slice(i).match(/^\$\d+/)?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) {
          unterminated = true;
          i = n;
        } else {
          i = close + tag.length;
        }
        push("string", start, i);
      } else if (param) {
        i += param.length;
        push("param", start, i);
      } else {
        i++;
        push("other", start, i);
      }
    } else if (WORD_START.test(ch)) {
      i++;
      while (i < n && WORD_PART.test(sql[i]!)) i++;
      push("word", start, i);
    } else if (ch === ";") {
      i++;
      push("semicolon", start, i);
    } else {
      i++;
      push("other", start, i);
    }
  }
  return { tokens, unterminated };
}

/** Upper-cased first word that is not a comment, or "". */
export function pgLeadingKeyword(sql: string): string {
  const first = lexPostgres(sql).tokens.find((t) => t.kind !== "comment");
  return first?.kind === "word"
    ? sql.slice(first.start, first.end).toUpperCase()
    : "";
}

/**
 * Executable statements: text between semicolons that has something other
 * than comments. Each is trimmed of trailing comments, so wrapping it never
 * swallows a following line.
 */
export function pgStatements(sql: string): {
  statements: string[];
  unterminated: boolean;
} {
  const { tokens, unterminated } = lexPostgres(sql);
  const statements: string[] = [];
  let first: PgToken | null = null;
  let last: PgToken | null = null;
  const flush = () => {
    if (first && last) statements.push(sql.slice(first.start, last.end));
    first = null;
    last = null;
  };
  for (const token of tokens) {
    if (token.kind === "semicolon") {
      flush();
      continue;
    }
    if (token.kind === "comment") {
      // Leading comments belong to the statement; trailing ones are dropped.
      if (!first) first = token;
      continue;
    }
    if (!first || first.kind === "comment") first = first ?? token;
    last = token;
  }
  flush();
  return { statements, unterminated };
}
