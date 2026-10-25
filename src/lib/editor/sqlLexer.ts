/**
 * A small SQL lexer for editor features: it tells code from string literals,
 * comments and quoted names, per dialect.
 */

export type LexOptions = {
  /** MySQL `# comment`. */
  hashComments?: boolean;
  /** MySQL and ClickHouse `'it\'s'`. */
  backslashEscapes?: boolean;
  /** MySQL `"text"` is a string, not a name. */
  doubleQuotedStrings?: boolean;
  /** PostgreSQL `$$text$$` and `$tag$text$tag$`. */
  dollarQuotes?: boolean;
  /** PostgreSQL `E'it\'s'`. */
  escapeStrings?: boolean;
  /** SQL Server and SQLite `[name]`. */
  brackets?: boolean;
  /** PostgreSQL and SQL Server `/* /* nested *\/ *\/`. */
  nestedComments?: boolean;
};

export type CursorPlace = "code" | "literal" | "comment";

export type MaskedSql = {
  /**
   * The input, same length so offsets carry over, with comments blanked and
   * every string literal turned into `'___'`: keywords and semicolons inside
   * them are gone. Quoted names are kept as written.
   */
  text: string;
  /**
   * `text` with the contents of quoted names turned into `_` too, for
   * finding keywords: `"from x"` or `[union]` is a name, not SQL.
   */
  keywords: string;
  /** Offsets of the semicolons that end statements. */
  semicolons: number[];
  /** What the cursor offset passed in is inside of. */
  cursorIn: CursorPlace;
};

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** End (exclusive) of the quoted token opened at `start`, and whether it closes. */
function scanQuoted(
  sql: string,
  start: number,
  close: string,
  backslash: boolean
): [number, boolean] {
  let j = start + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslash && ch === "\\") {
      j += 2;
    } else if (ch === close) {
      if (sql[j + 1] !== close) return [j + 1, true];
      j += 2;
    } else {
      j++;
    }
  }
  return [sql.length, false];
}

export function maskSql(sql: string, opts: LexOptions, cursor = -1): MaskedSql {
  const out: string[] = [];
  const semicolons: number[] = [];
  const names: Array<[number, number]> = [];
  let cursorIn: CursorPlace = "code";
  let flushed = 0;
  let i = 0;
  const n = sql.length;

  /** Replace [start, end) with `text`; note the cursor if it is inside. */
  const token = (
    start: number,
    end: number,
    closed: boolean,
    place: CursorPlace,
    text: string
  ) => {
    if (cursor > start && (cursor < end || (!closed && cursor <= end))) {
      cursorIn = place;
    }
    out.push(sql.slice(flushed, start), text);
    flushed = end;
    i = end;
  };
  const literal = (start: number, end: number, closed: boolean) =>
    token(
      start,
      end,
      closed,
      "literal",
      closed && end - start >= 2
        ? `'${"_".repeat(end - start - 2)}'`
        : `'${"_".repeat(end - start - 1)}`
    );

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";

    if ((ch === "-" && next === "-") || (opts.hashComments && ch === "#")) {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      // The cursor at the end of a line comment is still in it.
      token(i, end, false, "comment", " ".repeat(end - i));
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else if (
          opts.nestedComments &&
          sql[j] === "/" &&
          sql[j + 1] === "*"
        ) {
          depth++;
          j += 2;
        } else {
          j++;
        }
      }
      token(i, j, depth === 0, "comment", " ".repeat(j - i));
      continue;
    }

    if (ch === "'" || (ch === '"' && opts.doubleQuotedStrings)) {
      const escapes =
        !!opts.backslashEscapes ||
        (!!opts.escapeStrings &&
          (sql[i - 1] === "E" || sql[i - 1] === "e") &&
          !IDENT_CHAR.test(sql[i - 2] ?? ""));
      const [end, closed] = scanQuoted(sql, i, ch, escapes);
      literal(i, end, closed);
      continue;
    }

    if (opts.dollarQuotes && ch === "$" && !IDENT_CHAR.test(sql[i - 1] ?? "")) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 66))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        literal(i, end, close !== -1);
        continue;
      }
    }

    if (ch === '"' || ch === "`" || (opts.brackets && ch === "[")) {
      const [end] = scanQuoted(sql, i, ch === "[" ? "]" : ch, false);
      // A quoted name is code: keep it as written.
      names.push([i, end]);
      i = end;
      continue;
    }

    if (ch === ";") semicolons.push(i);
    i++;
  }
  out.push(sql.slice(flushed));
  const text = out.join("");

  const kw: string[] = [];
  let at = 0;
  for (const [start, end] of names) {
    kw.push(
      text.slice(at, start + 1),
      "_".repeat(Math.max(0, end - start - 2))
    );
    at = Math.max(start + 1, end - 1);
  }
  kw.push(text.slice(at));

  return { text, keywords: kw.join(""), semicolons, cursorIn };
}
