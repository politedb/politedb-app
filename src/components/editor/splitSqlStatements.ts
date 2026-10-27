type SplitStmt = { text: string; start: number; end: number };

function isIdentChar(ch: string) {
  return /[A-Za-z0-9_]/.test(ch);
}

/** A PostgreSQL identifier character (any non-ASCII character counts). */
function isPgIdentChar(ch: string | undefined) {
  return !!ch && (ch >= "\u0080" || /[A-Za-z0-9_$]/.test(ch));
}

/**
 * A PostgreSQL dollar-quote opener at i: $$ or $tag$, where the tag is an
 * identifier that does not start with a digit, and the "$" does not
 * continue an identifier (foo$bar$ is one identifier).
 */
function scanPgDollarTag(sql: string, i: number) {
  if (isPgIdentChar(sql[i - 1])) return null;
  const n = sql.length;
  let j = i + 1;
  while (j < n && sql[j] !== "$") {
    const ch = sql[j]!;
    if (
      !(
        ch >= "\u0080" ||
        /[A-Za-z_]/.test(ch) ||
        (j > i + 1 && /[0-9]/.test(ch))
      )
    )
      return null;
    j++;
  }
  if (j >= n) return null;
  return { tag: sql.slice(i, j + 1), end: j + 1 };
}

/**
 * PostgreSQL continues a string across whitespace holding a newline (and
 * "--" comments): 'a'<newline>'b' is 'ab', read in the first part's
 * escape mode (E'…' or not).
 */
// Vertical tab counts as whitespace on both sides of the newline
// (PostgreSQL 17 non_newline_space); older versions reject it, which only
// makes the whole statement fail.
const PG_STRING_CONTINUATION =
  /^(?:[ \t\f\v]|--[^\n\r]*)*[\n\r](?:[ \t\n\r\f\v]+|--[^\n\r]*[\n\r])*$/;

function scanDollarTag(sql: string, i: number) {
  // expects sql[i] === '$'
  // parses: $$ or $tag$ where tag = [A-Za-z0-9_]+ (can be empty)
  const n = sql.length;
  let j = i + 1;
  while (j < n && sql[j] !== "$") {
    if (!isIdentChar(sql[j])) return null;
    j++;
  }
  if (j >= n) return null;
  // tag is sql.slice(i, j+1) inclusive, e.g. "$tag$" or "$$"
  return { tag: sql.slice(i, j + 1), end: j + 1 };
}

/**
 * How strings and comments are read, so a ";" inside them never splits:
 * - postgres: a backslash is an ordinary character in '…' and "…" (only
 *   E'…' strings take backslash escapes, also in their continuations),
 *   block comments nest, backticks are ordinary characters, dollar-quote
 *   tags follow identifier rules.
 * - default (MySQL/MariaDB and other engines): a backslash escapes the
 *   next character inside '…' and "…".
 * Reading PostgreSQL text the default way ends strings in the wrong place:
 * 'a\' would swallow the rest, and text inside a later string would be
 * split into statements of its own.
 */
export type SqlSplitDialect = "postgres" | "default";

/** The splitter dialect for an engine. */
export function splitDialectFor(engine?: string | null): SqlSplitDialect {
  return engine === "postgres" ? "postgres" : "default";
}

export function splitSqlStatements(
  sql: string,
  options?: { dialect?: SqlSplitDialect }
): SplitStmt[] {
  const pg = options?.dialect === "postgres";
  const out: SplitStmt[] = [];
  const n = sql.length;

  let start = 0;
  let i = 0;

  let inSingle = false; // '
  /** The current '…' string takes backslash escapes. */
  let singleEscapes = false;
  /** Where the last '…' string ended, and its escape mode (continuations). */
  let lastSingleEnd = -1;
  let lastSingleEscapes = false;
  let inDouble = false; // "
  let inBacktick = false; // `
  let inLineComment = false; // --
  let inBlockComment = false; // /* */
  let blockDepth = 0; // nesting, PostgreSQL only
  let dollarTag: string | null = null; // $$ or $tag$

  const push = (to: number) => {
    const raw = sql.slice(start, to);
    const text = raw.trim();
    if (text) out.push({ text, start, end: to });
    start = to;
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    // ---- In line comment
    if (inLineComment) {
      // PostgreSQL also ends it at a carriage return; MySQL and SQLite
      // only at a line feed.
      if (ch === "\n" || (pg && ch === "\r")) inLineComment = false;
      i++;
      continue;
    }

    // ---- In block comment
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        blockDepth--;
        if (blockDepth <= 0) inBlockComment = false;
        i += 2;
        continue;
      }
      if (pg && ch === "/" && next === "*") {
        blockDepth++;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // ---- In dollar-quoted string (Postgres)
    if (dollarTag) {
      if (ch === "$") {
        // Inside the body only the exact closing tag matters.
        const probe = sql.startsWith(dollarTag, i)
          ? { tag: dollarTag, end: i + dollarTag.length }
          : null;
        if (probe && probe.tag === dollarTag) {
          // close tag
          i = probe.end;
          dollarTag = null;
          continue;
        }
      }
      i++;
      continue;
    }

    // ---- In single quotes '
    if (inSingle) {
      if (singleEscapes && ch === "\\") {
        // MySQL-style backslash escapes inside string literal (e.g. \', \", \\)
        i += 2;
        continue;
      }
      if (ch === "'") {
        // SQL standard escape: '' inside strings
        if (next === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
        lastSingleEnd = i + 1;
        lastSingleEscapes = singleEscapes;
      }
      i++;
      continue;
    }

    // ---- In double quotes "
    if (inDouble) {
      if (!pg && ch === "\\") {
        // Support backslash escapes in engines that allow it.
        i += 2;
        continue;
      }
      if (ch === '"') {
        // SQL standard escape: "" inside identifiers/strings
        if (next === '"') {
          i += 2;
          continue;
        }
        inDouble = false;
      }
      i++;
      continue;
    }

    // ---- In backticks ` (MySQL identifiers)
    if (inBacktick) {
      if (ch === "`") {
        // escape: `` inside backticks
        if (next === "`") {
          i += 2;
          continue;
        }
        inBacktick = false;
      }
      i++;
      continue;
    }

    // ---- Not in any string/comment: check comment starts
    if (ch === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      blockDepth = 1;
      i += 2;
      continue;
    }

    // ---- Enter quotes
    if (ch === "'") {
      inSingle = true;
      // PostgreSQL: only an E'…' (e'…') string takes backslash escapes.
      if (!pg) {
        singleEscapes = true;
      } else if (
        lastSingleEnd >= 0 &&
        PG_STRING_CONTINUATION.test(sql.slice(lastSingleEnd, i))
      ) {
        // A continuation keeps the escape mode of the string it continues.
        singleEscapes = lastSingleEscapes;
      } else {
        singleEscapes =
          /[eE]/.test(sql[i - 1] ?? "") && !isPgIdentChar(sql[i - 2]);
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "`" && !pg) {
      inBacktick = true;
      i++;
      continue;
    }

    // ---- Enter dollar quote
    if (ch === "$") {
      const probe = pg ? scanPgDollarTag(sql, i) : scanDollarTag(sql, i);
      if (probe) {
        dollarTag = probe.tag;
        i = probe.end;
        continue;
      }
    }

    // ---- Statement separator
    if (ch === ";") {
      push(i); // push up to before ';'
      start = i + 1; // skip ';'
      i++;
      continue;
    }

    i++;
  }

  // last tail
  push(n);

  return out;
}
