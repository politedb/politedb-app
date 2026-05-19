import { format, type SqlLanguage } from "sql-formatter";
import type { DatabaseEngine } from "src/types";

const engineToLanguage: Partial<Record<DatabaseEngine, SqlLanguage>> = {
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
  d1: "sqlite",
  mariadb: "mariadb",
};

export type FormatOptions = {
  engine?: DatabaseEngine;
  tabWidth?: number;
  keywordCase?: "upper" | "lower" | "preserve";
  indentStyle?: "standard" | "tabularLeft" | "tabularRight";
};

export function formatSql(sql: string, options: FormatOptions = {}): string {
  const {
    engine = "postgres",
    tabWidth = 2,
    keywordCase = "upper",
    indentStyle = "standard",
  } = options;

  try {
    return format(sql, {
      language: engineToLanguage[engine] ?? "postgresql",
      tabWidth,
      keywordCase,
      indentStyle,
      linesBetweenQueries: 2,
      denseOperators: false,
      newlineBeforeSemicolon: false,
    });
  } catch (error) {
    // Return original if parsing fails
    console.warn("[formatSql] Failed to format:", error);
    return sql;
  }
}

// Format selection or full content
export function formatSqlSmart(
  fullSql: string,
  selection?: { start: number; end: number }
): string {
  if (!selection) {
    return formatSql(fullSql);
  }

  const before = fullSql.slice(0, selection.start);
  const selected = fullSql.slice(selection.start, selection.end);
  const after = fullSql.slice(selection.end);

  const formatted = formatSql(selected);

  return before + formatted + after;
}

// Minimal, safe SQL minifier (counterpart of formatSql).
// Goals:
// - Collapse whitespace outside strings/comments
// - Keep strings, quoted identifiers, and comments intact (do not rewrite contents)
// - Preserve statement separators ';'
// - Avoid breaking SQL like `-- comment` (keep newline as a safe boundary)

export type MinifySqlOptions = {
  // Keep line breaks that terminate -- line comments (recommended true)
  keepLineBreaksAfterLineComments?: boolean; // default true
};

export function minifySql(input: string, opts: MinifySqlOptions = {}): string {
  const keepLineBreaksAfterLineComments =
    opts.keepLineBreaksAfterLineComments ?? true;

  const s = input.replace(/\r\n/g, "\n");

  let out = "";
  let i = 0;

  let inSingle = false; // '...'
  let inDouble = false; // "...", quoted ident (PG)
  let inBacktick = false; // `...` (MySQL)
  let inLineComment = false; // -- ...
  let inBlockComment = false; // /* ... */

  // Whether last emitted char is whitespace (space or newline marker)
  let pendingSpace = false;

  const emitSpace = () => {
    if (!pendingSpace && out && !out.endsWith(" ")) pendingSpace = true;
  };

  const flushSpace = () => {
    if (!pendingSpace) return;
    // Avoid spaces right after '(' or before ')' / ',' / ';' / '.'
    const last = out[out.length - 1] ?? "";
    if (!last) {
      pendingSpace = false;
      return;
    }
    if (last === "(" || last === "." || last === ",") {
      pendingSpace = false;
      return;
    }
    out += " ";
    pendingSpace = false;
  };

  const emit = (ch: string) => {
    flushSpace();
    out += ch;
  };

  const emitRaw = (ch: string) => {
    // for comments/strings: keep as-is, do not compress internal whitespace
    out += ch;
    pendingSpace = false;
  };

  while (i < s.length) {
    const ch = s[i]!;
    const next = s[i + 1] ?? "";

    // ---------- Line comment ----------
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;

        // newline is important boundary after -- comment
        if (keepLineBreaksAfterLineComments) {
          // trim trailing spaces before newline
          out = out.replace(/[ \t]+$/g, "");
          out += "\n";
        } else {
          emitSpace();
        }
      } else {
        emitRaw(ch);
      }
      i++;
      continue;
    }

    // ---------- Block comment ----------
    if (inBlockComment) {
      emitRaw(ch);
      if (ch === "*" && next === "/") {
        emitRaw("/");
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // ---------- Single-quoted string ----------
    if (inSingle) {
      emitRaw(ch);

      // SQL escape: '' inside string
      if (ch === "'" && next === "'") {
        emitRaw("'");
        i += 2;
        continue;
      }

      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    // ---------- Double-quoted identifier ----------
    if (inDouble) {
      emitRaw(ch);

      // escape: "" inside identifier
      if (ch === `"` && next === `"`) {
        emitRaw(`"`);
        i += 2;
        continue;
      }

      if (ch === `"`) inDouble = false;
      i++;
      continue;
    }

    // ---------- Backtick-quoted identifier ----------
    if (inBacktick) {
      emitRaw(ch);

      // MySQL escape: `` inside identifier
      if (ch === "`" && next === "`") {
        emitRaw("`");
        i += 2;
        continue;
      }

      if (ch === "`") inBacktick = false;
      i++;
      continue;
    }

    // ---------- Not in any string/comment ----------
    // Start comments
    if (ch === "-" && next === "-") {
      flushSpace();
      emitRaw("-");
      emitRaw("-");
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      flushSpace();
      emitRaw("/");
      emitRaw("*");
      inBlockComment = true;
      i += 2;
      continue;
    }

    // Start strings / quoted identifiers
    if (ch === "'") {
      flushSpace();
      emitRaw("'");
      inSingle = true;
      i++;
      continue;
    }

    if (ch === `"`) {
      flushSpace();
      emitRaw(`"`);
      inDouble = true;
      i++;
      continue;
    }

    if (ch === "`") {
      flushSpace();
      emitRaw("`");
      inBacktick = true;
      i++;
      continue;
    }

    // Whitespace -> collapse to one space
    if (ch === " " || ch === "\t" || ch === "\n") {
      emitSpace();
      i++;
      continue;
    }

    // Punctuation spacing rules (trim spaces around)
    if (ch === "," || ch === ";" || ch === ")") {
      // remove any pending space before these tokens
      pendingSpace = false;
      // also trim trailing space in output (shouldn't happen often)
      out = out.replace(/[ \t]+$/g, "");
      out += ch;
      i++;
      // after comma add a single space
      if (ch === ",") emitSpace();
      continue;
    }

    if (ch === "(") {
      // remove any space before '('
      pendingSpace = false;
      out = out.replace(/[ \t]+$/g, "");
      out += ch;
      i++;
      continue;
    }

    if (ch === ".") {
      // no spaces around dot
      pendingSpace = false;
      out = out.replace(/[ \t]+$/g, "");
      out += ".";
      i++;
      continue;
    }

    // Normal character
    emit(ch);
    i++;
  }

  // finalize
  if (keepLineBreaksAfterLineComments) {
    // trim trailing spaces on each line, then trim overall
    out = out
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trim();
  } else {
    out = out.replace(/\s+/g, " ").trim();
  }

  return out;
}
