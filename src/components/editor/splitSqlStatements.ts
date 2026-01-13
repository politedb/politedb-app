type SplitStmt = { text: string; start: number; end: number };

function isIdentChar(ch: string) {
  return /[A-Za-z0-9_]/.test(ch);
}

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

export function splitSqlStatements(sql: string): SplitStmt[] {
  const out: SplitStmt[] = [];
  const n = sql.length;

  let start = 0;
  let i = 0;

  let inSingle = false; // '
  let inDouble = false; // "
  let inBacktick = false; // `
  let inLineComment = false; // --
  let inBlockComment = false; // /* */
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
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }

    // ---- In block comment
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // ---- In dollar-quoted string (Postgres)
    if (dollarTag) {
      if (ch === "$") {
        const probe = scanDollarTag(sql, i);
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
      if (ch === "'") {
        // SQL standard escape: '' inside strings
        if (next === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }

    // ---- In double quotes "
    if (inDouble) {
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
      i += 2;
      continue;
    }

    // ---- Enter quotes
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      i++;
      continue;
    }

    // ---- Enter dollar quote
    if (ch === "$") {
      const probe = scanDollarTag(sql, i);
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
