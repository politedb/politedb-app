const DDL_RE = /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT)\b/i;
const DML_RE =
  /^(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CALL|DO)\b/i;
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

export function isMutatingStatement(sql: string) {
  if (!sql) return false;

  let i = 0;
  const s = sql;
  const len = s.length;

  const skipWs = () => {
    while (i < len && /\s/.test(s[i]!)) i++;
  };

  const skipLineComment = () => {
    i += 2;
    while (i < len && s[i] !== "\n") i++;
  };

  const skipBlockComment = () => {
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
  return DDL_RE.test(head) || DML_RE.test(head) || TRANSACTION_RE.test(head);
}
