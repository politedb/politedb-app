/**
 * How the save review presents each statement, and which ones destroy
 * data. Judged from the start of each generated statement only, so text
 * inside literals (a default value, a definition body) never changes it.
 */

export type SaveStatementKind =
  | "create"
  | "insert"
  | "update"
  | "delete"
  | "structure"
  | "constraint"
  | "destructive";

const DROP_COLUMN_RE = /^ALTER\s+TABLE\s+.+?\s+DROP\s+COLUMN\s/is;
const DROP_TABLE_RE = /^DROP\s+TABLE\b/i;
const TRUNCATE_RE = /^TRUNCATE\b/i;
/** Replacing a routine or trigger drops it first; that is not data loss. */
const DROP_OBJECT_RE = /^DROP\s+(FUNCTION|PROCEDURE|TRIGGER)\b/i;

export function classifySaveStatement(sql: string): SaveStatementKind {
  const text = sql.trim();
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
}): string[] {
  const noun = args.rowNoun ?? { one: "row", many: "rows" };
  let columns = 0;
  let tables = 0;
  let truncates = 0;
  let others = 0;
  for (const sql of args.statements) {
    const text = sql.trim();
    if (DROP_COLUMN_RE.test(text)) columns += 1;
    else if (DROP_TABLE_RE.test(text)) tables += 1;
    else if (TRUNCATE_RE.test(text)) truncates += 1;
    else if (classifySaveStatement(text) === "destructive") others += 1;
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
