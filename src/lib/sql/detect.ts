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
/** Server-wide or persisted settings (MySQL/MariaDB); a plain SET is a session read. */
const GLOBAL_SET_RE =
  /^SET\s+(GLOBAL|PERSIST|PERSIST_ONLY)\b|^SET\s+@@(GLOBAL|PERSIST|PERSIST_ONLY)\./i;
const DML_KEYWORD_RE = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i;

/** The text with quoted strings and identifiers blanked out. */
function withoutQuoted(text: string): string {
  return text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g, " ");
}

/**
 * Where the statement starts after leading whitespace and comments, or -1
 * when a MySQL/MariaDB executable comment (`/*! … *\/`, `/*M! … *\/`) runs
 * code. Block comments nest in PostgreSQL and not in MySQL, so both readings
 * are asked for and checked.
 */
function statementStart(s: string, nestedComments: boolean): number {
  let i = 0;
  const len = s.length;
  while (i < len) {
    while (i < len && /\s/.test(s[i]!)) i++;
    if (s.startsWith("--", i) || s[i] === "#") {
      while (i < len && s[i] !== "\n") i++;
      continue;
    }
    if (s.startsWith("/*", i)) {
      if (s.startsWith("/*!", i) || s.startsWith("/*M!", i)) return -1;
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
      continue;
    }
    break;
  }
  return i;
}

function headIsWrite(head: string): boolean {
  if (
    DDL_RE.test(head) ||
    DML_RE.test(head) ||
    TRANSACTION_RE.test(head) ||
    OTHER_WRITE_RE.test(head) ||
    GLOBAL_SET_RE.test(head)
  ) {
    return true;
  }
  const code = withoutQuoted(head);
  // A writable CTE: WITH gone AS (DELETE … RETURNING *) SELECT …
  if (/^WITH\b/i.test(code)) return DML_KEYWORD_RE.test(code);
  // SELECT … INTO creates a table (PostgreSQL) or writes a file/variable.
  if (/^SELECT\b/i.test(code)) return /\bINTO\b/i.test(code);
  return false;
}

/**
 * Whether a statement may change the database (best effort, erring towards
 * yes): Lock and Production block these. Leading comments are skipped.
 */
export function isMutatingStatement(sql: string) {
  if (!sql) return false;
  for (const nested of [true, false]) {
    const start = statementStart(sql, nested);
    if (start < 0) return true;
    if (headIsWrite(sql.slice(start).trimStart())) return true;
  }
  return false;
}
