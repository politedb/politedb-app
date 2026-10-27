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
  /^(GRANT|REVOKE|COPY|LOAD|IMPORT|REFRESH|REINDEX|VACUUM|CLUSTER)\b/i;
/**
 * Server-wide or persisted settings (MySQL/MariaDB), anywhere in a SET list;
 * a plain SET is a session read.
 */
const GLOBAL_SETTING_RE = /\b(GLOBAL|PERSIST|PERSIST_ONLY)\b|@@\s*GLOBAL\b/i;
const DML_KEYWORD_RE = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i;
const INTO_RE = /\bINTO\b/i;

/**
 * The statement's executable text: quoted strings and identifiers ('…',
 * "…", `…`, PostgreSQL $tag$…$tag$) and comments (--, #, /* *\/) become
 * spaces, so only real tokens are matched. Null when a MySQL/MariaDB
 * executable comment (/*! … *\/, /*M! … *\/) runs code. Dialects differ:
 * block comments nest in PostgreSQL and not in MySQL, and a backslash
 * escapes a quote in MySQL strings and not in standard SQL. Callers check
 * every reading, so a write seen by any of them counts.
 */
function executableText(
  s: string,
  nestedComments: boolean,
  backslashEscapes: boolean
): string | null {
  const len = s.length;
  let out = "";
  let i = 0;
  while (i < len) {
    const c = s[i]!;
    if (s.startsWith("--", i) || c === "#") {
      while (i < len && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (s.startsWith("/*", i)) {
      if (s.startsWith("/*!", i) || s.startsWith("/*M!", i)) return null;
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (nestedComments && s.startsWith("/*", i)) {
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
      i++;
      while (i < len) {
        if (backslashEscapes && s[i] === "\\") {
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
    if (c === "$" && !/[\w$]/.test(s[i - 1] ?? "")) {
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
  return false;
}

/**
 * Whether a statement may change the database (best effort, erring towards
 * yes): Lock and Production block these.
 */
export function isMutatingStatement(sql: string) {
  if (!sql) return false;
  for (const nested of [true, false]) {
    for (const backslash of [false, true]) {
      const text = executableText(sql, nested, backslash);
      if (text === null) return true;
      if (codeIsWrite(text.replace(/\s+/g, " ").trim())) return true;
    }
  }
  return false;
}
