/**
 * How the save review presents each statement, and which ones destroy
 * data. Judged on the statement's own keywords: string literals, quoted
 * identifiers and comments are blanked out first, so a default value or a
 * table name that reads "DROP COLUMN" never changes the verdict.
 */

export type SaveStatementKind =
  | "create"
  | "insert"
  | "update"
  | "delete"
  | "structure"
  | "constraint"
  | "destructive";

const DROP_COLUMN_RE = /^ALTER\s+TABLE\b.*\bDROP\s+COLUMN\b/is;
/** ClickHouse row mutations: ALTER TABLE t DELETE / UPDATE ... WHERE. */
const ALTER_DELETE_RE =
  /^ALTER\s+TABLE\s+\S+(\s+ON\s+CLUSTER\s+\S+)?\s+DELETE\b/is;
const ALTER_UPDATE_RE =
  /^ALTER\s+TABLE\s+\S+(\s+ON\s+CLUSTER\s+\S+)?\s+UPDATE\b/is;

/** Engines whose quoted strings treat a backslash as an escape. */
const BACKSLASH_ESCAPE_ENGINES = new Set(["mysql", "mariadb", "clickhouse"]);
/** Engines with PostgreSQL-style dollar quotes and E'' strings. */
const POSTGRES_LIKE_ENGINES = new Set(["postgres", "duckdb"]);

function isIdentChar(ch: string | undefined) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * The statement with literals, quoted identifiers and comments replaced
 * by a placeholder; keywords and structure stay. Quoting follows the
 * engine: a backslash escapes only on MySQL, MariaDB and ClickHouse (and
 * in PostgreSQL E'...' strings); elsewhere a quote is escaped by doubling
 * it. PostgreSQL dollar quotes and nested block comments are skipped too,
 * and SQL Server [identifiers] (with ]] for a literal bracket).
 */
export function sqlKeywordsOnly(sql: string, engine?: string): string {
  const backslashEngine = !!engine && BACKSLASH_ESCAPE_ENGINES.has(engine);
  const postgresLike = !!engine && POSTGRES_LIKE_ENGINES.has(engine);
  // [identifiers] are SQL Server's; elsewhere [ is an array subscript.
  const brackets = engine === "sqlserver";
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      // PostgreSQL block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (postgresLike && sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      i = j;
      out += " ";
      continue;
    }
    if (postgresLike && ch === "$" && !isIdentChar(sql[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        out += "q";
        continue;
      }
    }
    const close =
      ch === "'" || ch === '"' || ch === "`"
        ? ch
        : ch === "[" && brackets
          ? "]"
          : null;
    if (close) {
      const prev = sql[i - 1];
      const escapeString =
        close === "'" &&
        postgresLike &&
        (prev === "E" || prev === "e") &&
        !isIdentChar(sql[i - 2]);
      const backslash =
        (backslashEngine && (close === "'" || close === '"')) || escapeString;
      let j = i + 1;
      while (j < sql.length) {
        if (backslash && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === close) {
          // A doubled quote (or ]] in SQL Server) is escaped, not the end.
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
      out += "q";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const DROP_TABLE_RE = /^DROP\s+TABLE\b/i;
const TRUNCATE_RE = /^TRUNCATE\b/i;
/** Replacing a routine or trigger drops it first; that is not data loss. */
const DROP_OBJECT_RE = /^DROP\s+(FUNCTION|PROCEDURE|TRIGGER)\b/i;

export function classifySaveStatement(
  sql: string,
  engine?: string
): SaveStatementKind {
  const text = sqlKeywordsOnly(sql, engine).trim();
  const upper = text.toUpperCase();
  if (
    DROP_TABLE_RE.test(text) ||
    TRUNCATE_RE.test(text) ||
    DROP_COLUMN_RE.test(text)
  ) {
    return "destructive";
  }
  if (DROP_OBJECT_RE.test(text)) return "delete";
  // Index edits drop and recreate the index: no data is lost.
  if (/^DROP\s+INDEX\b/i.test(text)) return "structure";
  if (/^DROP\b/i.test(text)) return "destructive";
  if (upper.startsWith("CREATE")) return "create";
  if (upper.startsWith("INSERT")) return "insert";
  if (upper.startsWith("UPDATE")) return "update";
  if (upper.startsWith("DELETE")) return "delete";
  if (upper.includes(".INSERTONE(") || upper.includes(".INSERTMANY("))
    return "insert";
  if (upper.includes(".UPDATEONE(") || upper.includes(".UPDATEMANY("))
    return "update";
  if (upper.includes(".DELETEONE(") || upper.includes(".DELETEMANY("))
    return "delete";
  if (ALTER_DELETE_RE.test(text)) return "delete";
  if (ALTER_UPDATE_RE.test(text)) return "update";
  if (upper.startsWith("ALTER TABLE")) {
    return /\bCONSTRAINT\b/.test(upper) ? "constraint" : "structure";
  }
  return "structure";
}

/**
 * Plain-language list of what cannot be undone, e.g.
 * ["deletes 3 rows", "drops 1 column"]; empty when nothing is.
 */
export function describeDestructiveChanges(args: {
  statements: string[];
  deletedRows: number;
  rowNoun?: { one: string; many: string };
  /** Decides how quoted text is read (see sqlKeywordsOnly). */
  engine?: string;
}): string[] {
  const noun = args.rowNoun ?? { one: "row", many: "rows" };
  let columns = 0;
  let tables = 0;
  let truncates = 0;
  let others = 0;
  for (const sql of args.statements) {
    const text = sqlKeywordsOnly(sql, args.engine).trim();
    if (DROP_COLUMN_RE.test(text)) columns += 1;
    else if (DROP_TABLE_RE.test(text)) tables += 1;
    else if (TRUNCATE_RE.test(text)) truncates += 1;
    else if (classifySaveStatement(sql, args.engine) === "destructive") {
      others += 1;
    }
  }
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (args.deletedRows > 0) {
    parts.push(`deletes ${count(args.deletedRows, noun.one, noun.many)}`);
  }
  if (columns > 0) parts.push(`drops ${count(columns, "column", "columns")}`);
  if (tables > 0) parts.push(`drops ${count(tables, "table", "tables")}`);
  if (truncates > 0) {
    parts.push(`empties ${count(truncates, "table", "tables")}`);
  }
  if (others > 0) {
    parts.push(`drops ${count(others, "other object", "other objects")}`);
  }
  return parts;
}
