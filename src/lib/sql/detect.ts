const DDL_RE = /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT)\b/i;
const DML_RE = /^(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CALL|DO)\b/i;
const TRANSACTION_RE = /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\b/i;

/**
 * Return true if the statement is DDL (best-effort).
 * Skips leading whitespace + SQL comments.
 */
export function isDDLStatement(sql: string) {
  if (!sql) return false;

  let i = 0;
  const s = sql;

  const len = s.length;

  const skipWs = () => {
    while (i < len && /\s/.test(s[i]!)) i++;
  };

  const skipLineComment = () => {
    // assumes starts with --
    i += 2;
    while (i < len && s[i] !== "\n") i++;
  };

  const skipBlockComment = () => {
    // assumes starts with /*
    i += 2;
    while (i + 1 < len) {
      if (s[i] === "*" && s[i + 1] === "/") {
        i += 2;
        return;
      }
      i++;
    }
  };

  while (i < len) {
    skipWs();

    if (i + 1 < len && s[i] === "-" && s[i + 1] === "-") {
      skipLineComment();
      continue;
    }

    if (i + 1 < len && s[i] === "/" && s[i + 1] === "*") {
      skipBlockComment();
      continue;
    }

    break;
  }

  const head = s.slice(i).trimStart();
  return DDL_RE.test(head);
}

/** Statements that change data, schema, permissions or server settings. */
const OTHER_WRITE_RE =
  /^(GRANT|REVOKE|COPY|LOAD|IMPORT|REFRESH|REINDEX|VACUUM|CLUSTER)(?![\p{L}\p{N}_$])/iu;

/**
 * A keyword as a whole token: SQL identifiers may hold letters, digits,
 * "_" and "$" (cost$into is one identifier, not INTO).
 */
function keywordRe(words: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_$])(?:${words})(?![\\p{L}\\p{N}_$])`,
    "iu"
  );
}
/**
 * Server-wide or persisted settings (MySQL/MariaDB), anywhere in a SET list;
 * a plain SET is a session read.
 */
const GLOBAL_SETTING_RE = new RegExp(
  `${keywordRe("GLOBAL|PERSIST|PERSIST_ONLY").source}|@@\\s*GLOBAL(?![\\p{L}\\p{N}_$])`,
  "iu"
);
const DML_KEYWORD_RE = keywordRe("INSERT|UPDATE|DELETE|MERGE");
const INTO_RE = keywordRe("INTO");

type Dialect = "postgres" | "mysql";

/**
 * The statement's executable text as one dialect reads it: quoted strings
 * and identifiers and comments become spaces, so only real tokens are
 * matched. Null when a MySQL/MariaDB executable comment (/*! … *\/,
 * /*M! … *\/) runs code.
 *
 * - postgres (and standard SQL): block comments nest, "--" always starts a
 *   comment, "#" is an operator, a backslash escapes only in E'…' strings,
 *   $tag$…$tag$ quotes text.
 * - mysql: block comments do not nest, "#" starts a comment, "--" only
 *   when followed by whitespace, a backslash escapes in '…' and "…".
 */
function executableText(s: string, dialect: Dialect): string | null {
  const pg = dialect === "postgres";
  const len = s.length;
  let out = "";
  let i = 0;
  const lineComment = () => {
    while (i < len && s[i] !== "\n") i++;
    out += " ";
  };
  while (i < len) {
    const c = s[i]!;
    if (s.startsWith("--", i) && (pg || i + 2 >= len || /\s/.test(s[i + 2]!))) {
      lineComment();
      continue;
    }
    if (c === "#" && !pg) {
      lineComment();
      continue;
    }
    if (s.startsWith("/*", i)) {
      if (s.startsWith("/*!", i) || s.startsWith("/*M!", i)) return null;
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (pg && s.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (s.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      // PostgreSQL E'…' (e'…') strings take backslash escapes.
      const escapes = pg
        ? c === "'" &&
          /[eE]/.test(s[i - 1] ?? "") &&
          !/[\p{L}\p{N}_$]/u.test(s[i - 2] ?? "")
        : c !== "`";
      i++;
      while (i < len) {
        if (escapes && s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === c) {
          // A doubled quote is a quote inside the string.
          if (s[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (pg && c === "$" && !/[\p{L}\p{N}_$]/u.test(s[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))?.[0];
      if (tag) {
        const end = s.indexOf(tag, i + tag.length);
        i = end < 0 ? len : end + tag.length;
        out += " ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** EXPLAIN runs its statement only with ANALYZE: then it is that statement. */
function explainedStatement(code: string): string | null {
  const parenthesized = /^EXPLAIN\s*\(([^)]*)\)\s*/i.exec(code);
  if (parenthesized) {
    const analyze =
      /(?<![\w$])ANALY[SZ]E(?![\w$])(?!\s+(?:FALSE|OFF|0)(?![\w$]))/i;
    return analyze.test(parenthesized[1]!)
      ? code.slice(parenthesized[0].length)
      : null;
  }
  const words = /^EXPLAIN((?:\s+(?:ANALY[SZ]E|VERBOSE))*)\s+/i.exec(code);
  if (words && /ANALY[SZ]E/i.test(words[1]!)) {
    return code.slice(words[0].length);
  }
  return null;
}

function codeIsWrite(code: string): boolean {
  if (
    DDL_RE.test(code) ||
    DML_RE.test(code) ||
    TRANSACTION_RE.test(code) ||
    OTHER_WRITE_RE.test(code)
  ) {
    return true;
  }
  if (/^SET\b/i.test(code)) return GLOBAL_SETTING_RE.test(code);
  // A writable CTE (WITH gone AS (DELETE …) SELECT …) or a final
  // SELECT … INTO after the WITH list.
  if (/^WITH\b/i.test(code)) {
    return DML_KEYWORD_RE.test(code) || INTO_RE.test(code);
  }
  // SELECT … INTO creates a table (PostgreSQL) or writes a file/variable.
  if (/^SELECT\b/i.test(code)) return INTO_RE.test(code);
  if (/^EXPLAIN\b/i.test(code)) {
    const statement = explainedStatement(code);
    return statement !== null && codeIsWrite(statement);
  }
  return false;
}

/**
 * How to read a statement for an engine: by its own dialect when it is
 * PostgreSQL or MySQL/MariaDB, else (other or unknown engines) both ways,
 * counting a write seen by either.
 */
function dialectsFor(engine?: string): readonly Dialect[] {
  if (engine === "postgres") return ["postgres"];
  if (engine === "mysql" || engine === "mariadb") return ["mysql"];
  return ["postgres", "mysql"];
}

/**
 * Whether a statement may change the database (best effort, erring towards
 * yes): Lock and Production block these. Pass the connection's engine so
 * the statement is read by its dialect's comment and quoting rules.
 */
export function isMutatingStatement(sql: string, engine?: string) {
  if (!sql) return false;
  for (const dialect of dialectsFor(engine)) {
    const text = executableText(sql, dialect);
    if (text === null) return true;
    if (codeIsWrite(text.replace(/\s+/g, " ").trim())) return true;
  }
  return false;
}
