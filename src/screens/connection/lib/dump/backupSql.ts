import { runSqlQuery } from "src/lib/tauri/query";
import { dumpStream, type DumpOperation } from "src/lib/tauri/dumpOperation";
import { tableExportQuery, qIdent, qLiteral } from "src/lib/queries/sql";
import { cellToString } from "src/utils/convert";
import type { ConnectionCreateInput } from "src/lib/tauri";
import {
  formatSqlInsertChunk,
  POSTGRES_MONEY_ARRAY_AS_NUMERIC,
  POSTGRES_MONEY_AS_NUMERIC,
  sqlQuoteString,
} from "../../hooks/sqlInsertLiteral";

/*
 * SQL and catalog helpers of database backup and restore: what a backup
 * writes (structure, types, rows) and what a restore checks. No UI, no
 * run orchestration (backupRun.ts, restoreRun.ts).
 */

/**
 * A schema-qualified name for a "-- …" comment line in a dump. Names may
 * legally hold line breaks; written raw, the rest of the name would end the
 * comment and run as SQL on restore. Control characters become spaces so
 * the comment stays one line.
 */
export function dumpCommentName(schema: string, name: string): string {
  return `${schema}.${name}`.replace(
    /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g,
    " "
  );
}

export function cellToBool(cell: unknown): boolean {
  if (typeof cell === "boolean") return cell;
  if (cell && typeof cell === "object" && (cell as any).t === "Bool") {
    return Boolean((cell as any).v);
  }
  const s = String(cellToString(cell, true) ?? "").toLowerCase();
  return s === "true" || s === "t" || s === "1";
}

export function ensureSqlEndsWithSemicolon(sql: string): string {
  const trimmed = (sql ?? "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith(";") ? `${trimmed}\n` : `${trimmed};\n`;
}

export function normalizePostgresDefaultExpr(expr: string): string {
  const raw = (expr ?? "").trim();
  if (!raw) return raw;

  // Guard against malformed nextval default where opening quote is missing:
  // nextval(seq_name'::regclass) -> nextval('seq_name'::regclass)
  if (/^nextval\(/i.test(raw) && /::regclass\)$/i.test(raw)) {
    const fixedMissingOpen = raw.replace(
      /^nextval\(([^'"][^)]*?)'::regclass\)$/i,
      "nextval('$1'::regclass)"
    );
    if (fixedMissingOpen !== raw) return fixedMissingOpen;

    // Also normalize form without any quotes:
    // nextval(seq_name::regclass) -> nextval('seq_name'::regclass)
    const fixedNoQuotes = raw.replace(
      /^nextval\(([^'"][^)]*?)::regclass\)$/i,
      "nextval('$1'::regclass)"
    );
    if (fixedNoQuotes !== raw) return fixedNoQuotes;
  }

  return raw;
}

export function parseBackupEngine(sql: string): string | null {
  const firstLines = sql.split(/\r?\n/, 20);
  for (const line of firstLines) {
    const m = line.match(/^--\s*Engine:\s*(.+)\s*$/i);
    if (m?.[1]) return m[1].trim().toLowerCase();
  }
  return null;
}

export function normalizeEngineNameForCompare(engine: string): string {
  const e = engine.toLowerCase();
  if (e === "mariadb") return "mysql";
  return e;
}

export function isIgnorableRestoreError(sql: string, err: unknown): boolean {
  const stmt = sql.trim().toUpperCase();
  // Only the error's own first line, with quoted names blanked: a DETAIL
  // line or an object named "already exists" must not pass for a
  // duplicate.
  const msg = (
    String(err instanceof Error ? err.message : (err ?? "")).split("\n")[0] ??
    ""
  )
    .replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|`[^`]*`/g, '""')
    .toLowerCase();

  // A dump statement starts with its "-- Structure …" comment line.
  const head = stmt.replace(/^(?:\s*--[^\n]*\n)+/, "").trimStart();
  const isDdl =
    head.startsWith("CREATE TABLE") ||
    head.startsWith("CREATE SCHEMA") ||
    head.startsWith("CREATE TYPE") ||
    head.startsWith("CREATE DOMAIN") ||
    head.startsWith("CREATE INDEX") ||
    head.startsWith("ALTER TABLE");

  if (!isDdl) return false;

  return (
    msg.includes("already exists") ||
    msg.includes("already a primary key") ||
    msg.includes("multiple primary keys") ||
    (msg.includes("constraint") && msg.includes("already")) ||
    msg.includes("duplicate key name") ||
    msg.includes("duplicate object")
  );
}

/** Long text cut in the middle, keeping its start and its end. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 3);
  return `${text.slice(0, max - tail).trimEnd()} … ${text.slice(-tail).trimStart()}`;
}

/**
 * A failed statement for the stop dialog: what it was, not its rows.
 * Leading comments are dropped and an INSERT is cut after VALUES, so a
 * statement of thousands of rows stays one line. DDL keeps its head (names,
 * types, defaults) up to the limit.
 */
export function restoreStatementLabel(sql: string, max = 160): string {
  const head = sql
    .replace(/^(?:\s*(?:--[^\n\r]*(?:\r\n?|\n|$)|\/\*[\s\S]*?\*\/))+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!head) return "(comment only)";
  const values = /^INSERT\b.*?\bVALUES\b/i.exec(head);
  if (values) return `${clip(values[0], max)} …`;
  return clip(head, max);
}

/**
 * A server error for the stop dialog, kept short so a "Failing row contains
 * (…)" detail or a long message cannot push the dialog past the screen: the
 * message line, then its first DETAIL and first HINT lines wherever they
 * are (CONTEXT, WHERE and other lines are left out), each cut in the
 * middle: at most about 1,000 characters in all. Values the
 * server echoes (a failing row, a duplicate key) stay, cut: they say which
 * row failed. The dialog is local and nothing is logged.
 */
export function restoreErrorSummary(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lines = message
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const [first, ...rest] = lines;
  if (!first) return "Unknown restore error";
  // The first DETAIL and the first HINT only: a message repeating them
  // (or a failing row holding line breaks) stays bounded.
  const detail = rest.find((line) => /^DETAIL:/i.test(line));
  const hint = rest.find((line) => /^HINT:/i.test(line));
  const kept = [first, detail, hint]
    .filter((line): line is string => !!line)
    .map((line) => clip(line, 300));
  if (kept.length < lines.length) kept.push("…");
  return kept.join("\n");
}

export function parsePgAlterAddConstraint(sql: string): {
  schema: string;
  table: string;
  constraint: string;
} | null {
  const quoted = sql.match(
    /^ALTER\s+TABLE\s+"([^"]+)"\."([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"/i
  );
  if (quoted) {
    return {
      schema: quoted[1],
      table: quoted[2],
      constraint: quoted[3],
    };
  }

  const plain = sql.match(
    /^ALTER\s+TABLE\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s+ADD\s+CONSTRAINT\s+([A-Za-z0-9_]+)/i
  );
  if (!plain) return null;
  return {
    schema: plain[1],
    table: plain[2],
    constraint: plain[3],
  };
}

/**
 * A PostgreSQL string literal for catalog queries: E'…' with doubled
 * backslashes when the text holds one, so a name with a backslash stays
 * one literal even where the server has standard_conforming_strings off.
 */
export function pgLiteral(value: string): string {
  return qLiteral(value, "postgres");
}

/**
 * The first words of a statement, uppercased, read the PostgreSQL way:
 * whitespace and comments (line comments, and block comments, which nest)
 * before and between them are skipped.
 */
export function pgLeadingWords(sql: string, count: number): string[] {
  const words: string[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n && words.length < count) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (sql.startsWith("--", i)) {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
    } else if (sql.startsWith("/*", i)) {
      let depth = 0;
      while (i < n) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      // A whole identifier: PostgreSQL counts every non-ASCII character
      // as part of one, so "transactioné" is not TRANSACTION.
      const start = i;
      while (i < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[i]!)) i++;
      // ASCII case folding only, as for keywords: a Unicode mapping turns
      // "transactıon" (dotless i) into TRANSACTION.
      words.push(
        sql.slice(start, i).replace(/[a-z]/g, (ch) => ch.toUpperCase())
      );
    } else {
      break;
    }
  }
  return words;
}

/**
 * A statement that controls transactions (BEGIN, COMMIT, END, ROLLBACK,
 * SAVEPOINT, PREPARE TRANSACTION…). Inside a run that owns its
 * transaction it would end it partway.
 */
export function isTransactionControl(sql: string): boolean {
  const [first = "", second = ""] = pgLeadingWords(sql, 2);
  if (
    [
      "BEGIN",
      "COMMIT",
      "END",
      "ROLLBACK",
      "ABORT",
      "SAVEPOINT",
      "RELEASE",
    ].includes(first)
  ) {
    return true;
  }
  return (first === "START" || first === "PREPARE") && second === "TRANSACTION";
}

export function isPgAddForeignKeyStatement(sql: string): boolean {
  const s = sql.trim().toUpperCase();
  return (
    s.startsWith("ALTER TABLE") &&
    s.includes("ADD CONSTRAINT") &&
    s.includes("FOREIGN KEY")
  );
}

export async function pgConstraintExists(args: {
  connectionId: string;
  schema: string;
  table: string;
  constraint: string;
}): Promise<boolean> {
  const { connectionId, schema, table, constraint } = args;
  const res = await runSqlQuery(
    connectionId,
    `
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${pgLiteral(schema)}
        AND t.relname = ${pgLiteral(table)}
        AND c.conname = ${pgLiteral(constraint)}
      LIMIT 1;
    `,
    { timeoutMs: 30_000, internal: true }
  );

  return Boolean(res.rows?.length);
}

export type BackupTable = {
  schema: string;
  name: string;
  kind?: string;
};

/**
 * The snapshot a running PostgreSQL backup reads, by runtime connection:
 * its catalog queries and row streams all see one database state, even
 * while others write. Set for the duration of a backup only.
 */
export const backupSnapshots = new Map<string, { snapshotId: string | null }>();

/** A query of a backup, reading its snapshot when it has one. */
export function backupQuery(
  connectionId: string,
  sql: string,
  opts?: Parameters<typeof runSqlQuery>[2]
) {
  // Dump queries never report to analytics (D13).
  const snapshotId = backupSnapshots.get(connectionId)?.snapshotId;
  return runSqlQuery(connectionId, sql, {
    ...opts,
    internal: true,
    ...(snapshotId ? { snapshotId } : {}),
  });
}

/**
 * Tables a dump inserts into that already exist and have rows (PostgreSQL),
 * as written in the dump ("schema"."table"). Only dump INSERT targets of
 * that exact quoted form are checked.
 */
export async function pgTablesWithRows(
  connectionId: string,
  statements: string[]
): Promise<string[]> {
  const targets = new Set<string>();
  for (const statement of statements) {
    const head = statement.replace(/^(?:\s*--[^\n]*\n)+/, "").trimStart();
    const m = /^INSERT INTO ("(?:[^"]|"")+"\."(?:[^"]|"")+")/.exec(head);
    if (m) targets.add(m[1]!);
  }
  const found: string[] = [];
  for (const table of targets) {
    try {
      const res = await runSqlQuery(
        connectionId,
        `SELECT to_regclass(${pgLiteral(table)}) IS NOT NULL;`,
        { internal: true }
      );
      if (!cellToBool(res.rows?.[0]?.[0])) continue;
      const rows = await runSqlQuery(
        connectionId,
        `SELECT EXISTS (SELECT 1 FROM ${table});`,
        { internal: true }
      );
      if (cellToBool(rows.rows?.[0]?.[0])) found.push(table);
    } catch {
      // Not readable here: the restore itself will say.
    }
  }
  return found;
}

/**
 * The tables to back up, as the backup's snapshot has them: every table in
 * the schemas the workspace shows (all but those starting "pg_" and
 * information_schema),
 * so a table or schema created since the workspace's lists loaded is
 * included and a dropped one is not.
 */
export async function postgresSnapshotTables(
  connectionId: string
): Promise<BackupTable[]> {
  const res = await backupQuery(
    connectionId,
    `
      SELECT n.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        -- The workspace's own schema rule (queries/metadata.ts).
        AND n.nspname <> 'information_schema'
        AND n.nspname !~ '^pg_'
      ORDER BY n.nspname, c.relname;
    `
  );
  return (res.rows ?? [])
    .map((r: any) => ({
      schema: cellToString(r?.[0]) ?? "",
      name: cellToString(r?.[1]) ?? "",
      kind: "table",
    }))
    .filter((t: BackupTable) => t.schema && t.name) as BackupTable[];
}

/** A table's columns, in order, as the backup's snapshot has them. */
export async function postgresSnapshotColumns(
  connectionId: string,
  schema: string,
  tableName: string
): Promise<string[]> {
  const ident = `${qIdent(schema, "postgres")}.${qIdent(tableName, "postgres")}`;
  const res = await backupQuery(
    connectionId,
    `
      SELECT a.attname
      FROM pg_attribute a
      WHERE a.attrelid = ${pgLiteral(ident)}::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum;
    `
  );
  return (res.rows ?? [])
    .map((r: any) => cellToString(r?.[0]) ?? "")
    .filter(Boolean);
}

export function tableNodeKey(t: { schema: string; name: string }) {
  return `${t.schema}.${t.name}`;
}

export async function loadForeignKeyDeps(args: {
  connectionId: string;
  engine: string;
}): Promise<Array<{ child: string; parent: string }>> {
  const { connectionId, engine } = args;
  const e = engine.toLowerCase();

  if (e === "postgres") {
    const res = await backupQuery(
      connectionId,
      `
        SELECT
          child_ns.nspname AS child_schema,
          child_tbl.relname AS child_table,
          parent_ns.nspname AS parent_schema,
          parent_tbl.relname AS parent_table
        FROM pg_constraint fk
        JOIN pg_class child_tbl ON child_tbl.oid = fk.conrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child_tbl.relnamespace
        JOIN pg_class parent_tbl ON parent_tbl.oid = fk.confrelid
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent_tbl.relnamespace
        WHERE fk.contype = 'f';
      `,
      { timeoutMs: 60_000 }
    );

    return (res.rows ?? [])
      .map((r: any) => {
        const childSchema = cellToString(r?.[0]) ?? "";
        const childTable = cellToString(r?.[1]) ?? "";
        const parentSchema = cellToString(r?.[2]) ?? "";
        const parentTable = cellToString(r?.[3]) ?? "";
        if (!childSchema || !childTable || !parentSchema || !parentTable) {
          return null;
        }
        return {
          child: `${childSchema}.${childTable}`,
          parent: `${parentSchema}.${parentTable}`,
        };
      })
      .filter(Boolean) as Array<{ child: string; parent: string }>;
  }

  if (e === "mysql" || e === "mariadb") {
    const res = await backupQuery(
      connectionId,
      `
        SELECT
          TABLE_SCHEMA AS child_schema,
          TABLE_NAME AS child_table,
          REFERENCED_TABLE_SCHEMA AS parent_schema,
          REFERENCED_TABLE_NAME AS parent_table
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_NAME IS NOT NULL;
      `,
      { timeoutMs: 60_000 }
    );

    return (res.rows ?? [])
      .map((r: any) => {
        const childSchema = cellToString(r?.[0]) ?? "";
        const childTable = cellToString(r?.[1]) ?? "";
        const parentSchema = cellToString(r?.[2]) ?? "";
        const parentTable = cellToString(r?.[3]) ?? "";
        if (!childSchema || !childTable || !parentSchema || !parentTable) {
          return null;
        }
        return {
          child: `${childSchema}.${childTable}`,
          parent: `${parentSchema}.${parentTable}`,
        };
      })
      .filter(Boolean) as Array<{ child: string; parent: string }>;
  }

  return [];
}

export async function sortTablesByForeignKeys(args: {
  connectionId: string;
  engine: string;
  tables: BackupTable[];
}): Promise<BackupTable[]> {
  const { connectionId, engine, tables } = args;
  if (tables.length <= 1) return tables;

  const deps = await loadForeignKeyDeps({ connectionId, engine });
  if (!deps.length) return tables;

  const allowed = new Set(tables.map((t) => tableNodeKey(t)));
  const originalOrder = new Map(
    tables.map((t, idx) => [tableNodeKey(t), idx] as const)
  );

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const t of tables) indegree.set(tableNodeKey(t), 0);

  for (const dep of deps) {
    if (!allowed.has(dep.child) || !allowed.has(dep.parent)) continue;
    if (dep.child === dep.parent) continue;

    const nexts = outgoing.get(dep.parent) ?? new Set<string>();
    if (nexts.has(dep.child)) continue;
    nexts.add(dep.child);
    outgoing.set(dep.parent, nexts);
    indegree.set(dep.child, (indegree.get(dep.child) ?? 0) + 1);
  }

  const queue = Array.from(indegree.entries())
    .filter(([, d]) => d === 0)
    .map(([k]) => k)
    .sort((a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));

  const orderedKeys: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    orderedKeys.push(node);

    const nexts = Array.from(outgoing.get(node) ?? []);
    nexts.sort(
      (a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0)
    );
    for (const next of nexts) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (orderedKeys.length < tables.length) {
    const missing = tables
      .map((t) => tableNodeKey(t))
      .filter((k) => !orderedKeys.includes(k));
    missing.sort(
      (a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0)
    );
    orderedKeys.push(...missing);
  }

  const byKey = new Map(tables.map((t) => [tableNodeKey(t), t] as const));
  return orderedKeys.map((k) => byKey.get(k)).filter(Boolean) as BackupTable[];
}

/**
 * PostgreSQL backup rows: every column read as its text form, as pg_dump
 * does. The binary values the driver decodes miss many types (composite
 * types, ranges of custom types, extension types such as hstore or
 * PostGIS, bytea arrays) and those came back as NULL, losing data. Each
 * text value is written as a quoted literal that the INSERT types by its
 * column, so it reads back as the same value.
 *
 * - format('%s', …) uses the type's output function, like pg_dump; a cast
 *   to text could run a user-defined cast instead. num_nulls tells a NULL
 *   from a composite whose fields are all NULL.
 * - The stream runs with fixed text formats (canonicalTextOutput): ISO
 *   dates, ISO 8601 intervals and exact floats, read the same anywhere.
 * - money follows the server's currency locale in text, and restoring
 *   money text reads it in the target's locale: money (and money[]) is
 *   read as numeric and written as a typed numeric, which converts to
 *   money as a number, checking the target keeps its decimal places
 *   (postgresMoneyValueSql). Money inside a composite or range type
 *   cannot be written that way, so its backup stops (postgresMoneyColumns).
 */
export function postgresBackupRowsQuery(
  schema: string,
  tableName: string,
  columns: string[],
  /** Columns of type money or money[] (or domains over them). */
  money: PostgresMoneyColumns = { scalar: new Set(), array: new Set() }
): string {
  const cols = columns
    .map((c) => {
      const id = qIdent(c, "postgres");
      const value = money.scalar.has(c)
        ? `(${id})::numeric::text`
        : money.array.has(c)
          ? `(${id})::numeric[]::text`
          : `format('%s', ${id})`;
      return `CASE WHEN num_nulls(${id}) = 1 THEN NULL ELSE ${value} END AS ${id}`;
    })
    .join(", ");
  return `SELECT ${cols} FROM ${qIdent(schema, "postgres")}.${qIdent(tableName, "postgres")};`;
}

export type PostgresMoneyColumns = {
  scalar: ReadonlySet<string>;
  array: ReadonlySet<string>;
};

/**
 * The table's columns holding money: as the column's type (or a domain
 * over it), as the element of its array type, or deeper. Deeper (in a
 * composite, a range, an array of arrays' domains…) throws: that text
 * would restore differently under another currency locale. So does a type
 * nested too deep to check.
 */
export async function postgresMoneyColumns(
  connectionId: string,
  schema: string,
  tableName: string
): Promise<PostgresMoneyColumns> {
  // Multiranges (and pg_range.rngmultitypid) exist from PostgreSQL 14.
  const versionRes = await backupQuery(
    connectionId,
    "SELECT current_setting('server_version_num')::int >= 140000;"
  );
  const multiranges = cellToBool(versionRes.rows?.[0]?.[0]);
  const multirangeStep = multiranges
    ? `
          UNION ALL
          SELECT r.rngtypid, 'r' FROM pg_range r WHERE r.rngmultitypid = t.oid`
    : "";
  // Walks each column's type: domains (no step), arrays ("a"), composite
  // fields ("c"), ranges and multiranges ("r"), down to money. A walk cut
  // at the depth limit is reported ("!"): unchecked is not money-free.
  const res = await backupQuery(
    connectionId,
    `
      WITH RECURSIVE walk(attname, oid, steps, hops) AS (
        SELECT a.attname, a.atttypid, ''::text, 0
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${pgLiteral(schema)}
          AND c.relname = ${pgLiteral(tableName)}
          AND a.attnum > 0
          AND NOT a.attisdropped
        UNION
        SELECT w.attname, nxt.oid, w.steps || nxt.step, w.hops + 1
        FROM walk w
        JOIN pg_type t ON t.oid = w.oid
        CROSS JOIN LATERAL (
          SELECT t.typbasetype, '' WHERE t.typtype = 'd'
          UNION ALL
          SELECT t.typelem, 'a' WHERE t.typcategory = 'A' AND t.typelem <> 0
          UNION ALL
          SELECT f.atttypid, 'c'
          FROM pg_attribute f
          WHERE t.typtype = 'c' AND f.attrelid = t.typrelid
            AND f.attnum > 0 AND NOT f.attisdropped
          UNION ALL
          SELECT r.rngsubtype, 'r' FROM pg_range r WHERE r.rngtypid = t.oid${multirangeStep}
        ) nxt(oid, step)
        WHERE w.hops < 32
      )
      SELECT attname, CASE WHEN oid = 'money'::regtype THEN steps ELSE '!' END
      FROM walk
      WHERE oid = 'money'::regtype OR hops >= 32;
    `
  );
  const scalar = new Set<string>();
  const array = new Set<string>();
  for (const r of (res.rows ?? []) as any[]) {
    const name = cellToString(r?.[0]) ?? "";
    const steps = cellToString(r?.[1], true) ?? "";
    if (!name) continue;
    if (steps === "") scalar.add(name);
    else if (steps === "a") array.add(name);
    else if (steps === "!") {
      throw new Error(
        `The column "${name}" of ${schema}.${tableName} has a type nested too deeply to check for money, so nothing was backed up. Back it up with pg_dump.`
      );
    } else {
      throw new Error(
        `The column "${name}" of ${schema}.${tableName} holds money inside another type. Money text depends on the server's currency locale and might restore as another amount, so nothing was backed up. Change the column to numeric, or back it up with pg_dump.`
      );
    }
  }
  return { scalar, array };
}

export async function exportTableToSqlParts(args: {
  append: (content: string) => void;
  connectionId: string;
  engine: ConnectionCreateInput["engine"];
  schema: string;
  tableName: string;
  columns: string[];
  /** PostgreSQL: the table has a GENERATED ALWAYS identity column. */
  overridingSystemValue?: boolean;
  /** Called with each running stream, so a cancel can stop it. */
  onStream?: (stream: DumpOperation<unknown>) => void;
  /** Rows written so far for this table. */
  onRows?: (rows: number) => void;
}) {
  const { append, connectionId, engine, schema, tableName, columns } = args;

  const money =
    engine === "postgres"
      ? await postgresMoneyColumns(connectionId, schema, tableName)
      : null;
  const query = money
    ? postgresBackupRowsQuery(schema, tableName, columns, money)
    : tableExportQuery(schema, tableName, columns, undefined, "AND", engine);
  let columnNames = columns;
  let columnTypes: string[] = columns.map(() => "");
  let rowsWritten = 0;

  const appendChunk = (chunk: {
    rows?: unknown[][];
    columns?: { name: string; db_type?: string | null }[];
  }) => {
    const rows = chunk.rows ?? [];
    if (!rows.length) return;

    if (chunk.columns?.length) {
      columnNames = chunk.columns.map((c) => c.name).filter(Boolean);
      columnTypes = chunk.columns.map((c) => String(c.db_type ?? ""));
      // Money read as numeric is written as a typed numeric.
      if (money) {
        columnTypes = columnTypes.map((type, i) =>
          money.scalar.has(columnNames[i]!)
            ? POSTGRES_MONEY_AS_NUMERIC
            : money.array.has(columnNames[i]!)
              ? POSTGRES_MONEY_ARRAY_AS_NUMERIC
              : type
        );
      }
    }

    const content = formatSqlInsertChunk({
      engine,
      schema,
      tableName,
      columnNames,
      columnTypes,
      rows,
      qIdent: (name, eng) => qIdent(name, eng as any),
      overridingSystemValue: args.overridingSystemValue,
    });
    if (!content) return;
    append(content);
    rowsWritten += rows.length;
    args.onRows?.(rowsWritten);
  };

  // A chunk that cannot be written fails the backup (finishing without it
  // would save a file missing those rows): the stream stops, its query is
  // cancelled, and nothing more is appended.
  const stream = dumpStream(connectionId, query, appendChunk, {
    batchSize: 250,
    maxRows: 10_000_000,
    canonicalTextOutput: engine === "postgres",
    snapshotId: backupSnapshots.get(connectionId)?.snapshotId ?? undefined,
  });
  args.onStream?.(stream);
  const settled = await stream.settled;
  if (settled.error !== undefined) {
    const err = settled.error;
    throw typeof err === "string"
      ? new Error(err)
      : err instanceof Error
        ? err
        : new Error("EXPORT_FAILED");
  }
}

export type PgTypeRow = {
  oid: string;
  schema: string;
  name: string;
  kind: string;
  /** Domains: base type SQL, and the type it is built on (array → element). */
  baseSql: string;
  baseOid: string;
  notNull: boolean;
  defaultExpr: string;
  checks: string;
  /** Enums: quoted labels, possibly none. */
  labels: string;
  /** Domains: COLLATE clause target when it differs from the base's. */
  collation: string;
  /** A collation outside pg_catalog: its catalog row as JSON, to recreate. */
  collationDef: string;
  collationSchema: string;
  collationName: string;
  /** Set when an extension owns the type. */
  extension: string;
  extensionSchema: string;
  /** Domains: sequences their default uses, as JSON [{schema, name}]. */
  sequences: string;
  /** Set when an extension owns the domain's collation. */
  collationExtension: string;
  collationExtensionSchema: string;
};

/** CREATE COLLATION for a collation's catalog row (any PostgreSQL 13+). */
export function createCollationSql(
  schema: string,
  name: string,
  defJson: string
): string {
  let def: Record<string, unknown>;
  try {
    def = JSON.parse(defJson) as Record<string, unknown>;
  } catch {
    return "";
  }
  const text = (key: string) =>
    typeof def[key] === "string" && def[key] ? (def[key] as string) : "";
  const options: string[] = [];
  if (def.collprovider === "b") {
    // PostgreSQL 17's builtin provider.
    options.push(
      "provider = builtin",
      `locale = ${sqlQuoteString(text("colllocale"), "postgres")}`
    );
  } else if (def.collprovider === "i") {
    // The ICU locale moved: collcollate (≤14), colliculocale (15–16),
    // colllocale (17+).
    const locale =
      text("colllocale") || text("colliculocale") || text("collcollate");
    options.push(
      "provider = icu",
      `locale = ${sqlQuoteString(locale, "postgres")}`
    );
    if (text("collicurules")) {
      options.push(
        `rules = ${sqlQuoteString(text("collicurules"), "postgres")}`
      );
    }
  } else if (def.collprovider === "c") {
    options.push(
      "provider = libc",
      `lc_collate = ${sqlQuoteString(text("collcollate"), "postgres")}`,
      `lc_ctype = ${sqlQuoteString(text("collctype"), "postgres")}`
    );
  } else {
    // Never reinterpret a provider as another: say so instead.
    throw new Error(
      `The collation ${schema}.${name} uses a provider backups cannot recreate (${String(def.collprovider)}).`
    );
  }
  if (def.collisdeterministic === false) options.push("deterministic = false");
  return ensureSqlEndsWithSemicolon(
    `CREATE COLLATION IF NOT EXISTS ${qIdent(schema, "postgres")}.${qIdent(name, "postgres")} (${options.join(", ")})`
  );
}

/**
 * What the backed-up tables need before they can be created: their schemas
 * (other than public), the extensions that own types they use, the
 * sequences domain defaults use, then the enum types and domains their
 * columns use — followed through arrays and domain bases to any depth, with
 * every domain after the domain it is built on.
 *
 * Composite and range types are not recreated.
 */
export async function buildPostgresTypesSql(args: {
  connectionId: string;
  tables: ReadonlyArray<{ schema: string; name: string }>;
}): Promise<string> {
  const { connectionId, tables } = args;
  if (!tables.length) return "";

  const tableList = tables
    .map((t) => `(${pgLiteral(t.schema)}, ${pgLiteral(t.name)})`)
    .join(", ");
  const res = await backupQuery(
    connectionId,
    `
    WITH RECURSIVE walk(type_oid) AS (
      SELECT a.atttypid
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname, c.relname) IN (${tableList})
        AND a.attnum > 0
        AND NOT a.attisdropped
      UNION
      SELECT next.oid
      FROM walk w
      JOIN pg_type t ON t.oid = w.type_oid
      CROSS JOIN LATERAL (VALUES
        (CASE WHEN t.typcategory = 'A' THEN t.typelem END),
        (NULLIF(t.typbasetype, 0))
      ) AS next(oid)
      WHERE next.oid IS NOT NULL AND next.oid <> 0
    )
    SELECT
      t.oid::text,
      n.nspname,
      t.typname,
      t.typtype::text,
      CASE WHEN t.typtype = 'd'
        THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END,
      CASE WHEN bt.typcategory = 'A' THEN bt.typelem ELSE bt.oid END::text,
      t.typnotnull,
      pg_get_expr(t.typdefaultbin, 0),
      (SELECT string_agg(
          'CONSTRAINT ' || quote_ident(c.conname) || ' ' ||
            pg_get_constraintdef(c.oid),
          ' ' ORDER BY c.conname)
        FROM pg_constraint c
        -- CHECK only: NOT NULL comes from typnotnull (PostgreSQL 17 also
        -- records it as a constraint).
        WHERE c.contypid = t.oid AND c.contype = 'c'),
      CASE WHEN t.typtype = 'e' THEN coalesce(
        (SELECT string_agg(quote_literal(e.enumlabel), ', '
            ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid), '') END,
      CASE WHEN t.typtype = 'd' AND t.typcollation <> 0
          AND t.typcollation IS DISTINCT FROM bt.typcollation
        THEN quote_ident(cn.nspname) || '.' || quote_ident(co.collname) END,
      CASE WHEN t.typtype = 'd' AND t.typcollation <> 0
          AND t.typcollation IS DISTINCT FROM bt.typcollation
          AND cn.nspname <> 'pg_catalog'
        THEN to_jsonb(co)::text END,
      cn.nspname,
      co.collname,
      x.extname,
      xn.nspname,
      (SELECT json_agg(json_build_object(
          'schema', sn.nspname, 'name', sq.relname))::text
        FROM pg_depend d
        JOIN pg_class sq ON sq.oid = d.refobjid AND sq.relkind = 'S'
        JOIN pg_namespace sn ON sn.oid = sq.relnamespace
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.refclassid = 'pg_class'::regclass),
      (SELECT ce.extname
        FROM pg_depend cd
        JOIN pg_extension ce ON ce.oid = cd.refobjid
        WHERE cd.classid = 'pg_collation'::regclass
          AND cd.objid = co.oid
          AND cd.refclassid = 'pg_extension'::regclass
          AND cd.deptype = 'e'),
      (SELECT cen.nspname
        FROM pg_depend cd
        JOIN pg_extension ce ON ce.oid = cd.refobjid
        JOIN pg_namespace cen ON cen.oid = ce.extnamespace
        WHERE cd.classid = 'pg_collation'::regclass
          AND cd.objid = co.oid
          AND cd.refclassid = 'pg_extension'::regclass
          AND cd.deptype = 'e')
    FROM (SELECT DISTINCT type_oid FROM walk) w
    JOIN pg_type t ON t.oid = w.type_oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_type bt ON bt.oid = t.typbasetype
    LEFT JOIN pg_collation co ON co.oid = t.typcollation
    LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
    LEFT JOIN pg_depend xd
      ON xd.classid = 'pg_type'::regclass
     AND xd.objid = t.oid
     AND xd.refclassid = 'pg_extension'::regclass
     AND xd.deptype = 'e'
    LEFT JOIN pg_extension x ON x.oid = xd.refobjid
    LEFT JOIN pg_namespace xn ON xn.oid = x.extnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, t.typname;`
  );

  const rows: PgTypeRow[] = (res.rows ?? []).map((r: any) => ({
    oid: cellToString(r?.[0]) ?? "",
    schema: cellToString(r?.[1]) ?? "",
    name: cellToString(r?.[2]) ?? "",
    kind: cellToString(r?.[3]) ?? "",
    baseSql: cellToString(r?.[4], true) ?? "",
    baseOid: cellToString(r?.[5], true) ?? "",
    notNull: cellToBool(r?.[6]),
    defaultExpr: cellToString(r?.[7], true) ?? "",
    checks: cellToString(r?.[8], true) ?? "",
    labels: cellToString(r?.[9], true) ?? "",
    collation: cellToString(r?.[10], true) ?? "",
    collationDef: cellToString(r?.[11], true) ?? "",
    collationSchema: cellToString(r?.[12], true) ?? "",
    collationName: cellToString(r?.[13], true) ?? "",
    extension: cellToString(r?.[14], true) ?? "",
    extensionSchema: cellToString(r?.[15], true) ?? "",
    sequences: cellToString(r?.[16], true) ?? "",
    collationExtension: cellToString(r?.[17], true) ?? "",
    collationExtensionSchema: cellToString(r?.[18], true) ?? "",
  }));

  const schemas = new Set(
    tables.map((t) => t.schema).filter((name) => name !== "public")
  );
  const addSchema = (name: string) => {
    if (name && name !== "public") schemas.add(name);
  };
  const ident = (schema: string, name: string) =>
    `${qIdent(schema, "postgres")}.${qIdent(name, "postgres")}`;

  // Types an extension owns come with the extension, not one by one.
  const extensions = new Map<string, string>();
  for (const row of rows) {
    if (!row.extension) continue;
    extensions.set(row.extension, row.extensionSchema);
    addSchema(row.extensionSchema);
  }
  const own = rows.filter((row) => !row.extension && row.schema && row.name);

  let enumsSql = "";
  for (const row of own) {
    if (row.kind !== "e") continue;
    addSchema(row.schema);
    enumsSql += ensureSqlEndsWithSemicolon(
      `CREATE TYPE ${ident(row.schema, row.name)} AS ENUM (${row.labels})`
    );
  }

  // Each domain after the domain it is built on.
  const domains = own.filter((row) => row.kind === "d" && row.baseSql);
  const byOid = new Map(domains.map((row) => [row.oid, row]));
  const ordered: PgTypeRow[] = [];
  const placed = new Set<string>();
  const place = (row: PgTypeRow, path: Set<string>) => {
    if (placed.has(row.oid) || path.has(row.oid)) return;
    path.add(row.oid);
    const base = byOid.get(row.baseOid);
    if (base) place(base, path);
    placed.add(row.oid);
    ordered.push(row);
  };
  for (const row of domains) place(row, new Set());

  const sequences = new Map<string, string>();
  const collations = new Map<string, string>();
  let domainsSql = "";
  for (const row of ordered) {
    addSchema(row.schema);
    let deps: Array<{ schema?: string; name?: string }> = [];
    try {
      deps = row.sequences ? JSON.parse(row.sequences) : [];
    } catch {
      deps = [];
    }
    for (const dep of deps) {
      if (!dep.schema || !dep.name) continue;
      addSchema(dep.schema);
      sequences.set(
        ident(dep.schema, dep.name),
        ensureSqlEndsWithSemicolon(
          `CREATE SEQUENCE IF NOT EXISTS ${ident(dep.schema, dep.name)}`
        )
      );
    }
    if (row.collationExtension) {
      // An extension's collation comes with the extension.
      extensions.set(row.collationExtension, row.collationExtensionSchema);
      addSchema(row.collationExtensionSchema);
    } else if (row.collationDef && row.collationSchema && row.collationName) {
      addSchema(row.collationSchema);
      collations.set(
        ident(row.collationSchema, row.collationName),
        createCollationSql(
          row.collationSchema,
          row.collationName,
          row.collationDef
        )
      );
    }
    domainsSql += ensureSqlEndsWithSemicolon(
      `CREATE DOMAIN ${ident(row.schema, row.name)} AS ${row.baseSql}` +
        `${row.collation ? ` COLLATE ${row.collation}` : ""}` +
        `${row.defaultExpr ? ` DEFAULT ${row.defaultExpr}` : ""}` +
        `${row.notNull ? " NOT NULL" : ""}` +
        `${row.checks ? ` ${row.checks}` : ""}`
    );
  }

  const schemasSql = [...schemas]
    .sort()
    .map((schema) =>
      ensureSqlEndsWithSemicolon(
        `CREATE SCHEMA IF NOT EXISTS ${qIdent(schema, "postgres")}`
      )
    )
    .join("");
  const extensionsSql = [...extensions]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, schema]) =>
      ensureSqlEndsWithSemicolon(
        `CREATE EXTENSION IF NOT EXISTS ${qIdent(name, "postgres")}` +
          (schema ? ` WITH SCHEMA ${qIdent(schema, "postgres")}` : "")
      )
    )
    .join("");
  // Sequences are owned by their tables later.
  const byName = ([a]: [string, string], [b]: [string, string]) =>
    a.localeCompare(b);
  const sequencesSql = [...sequences]
    .sort(byName)
    .map(([, sql]) => sql)
    .join("");
  const collationsSql = [...collations]
    .sort(byName)
    .map(([, sql]) => sql)
    .join("");

  return `${schemasSql}${extensionsSql}${collationsSql}${sequencesSql}${enumsSql}${domainsSql}`;
}

/**
 * The rows of a table whose columns are all generated, as many rows of
 * defaults (there is nothing else to restore).
 */
export async function postgresGeneratedOnlyRowsSql(
  connectionId: string,
  schema: string,
  tableName: string
): Promise<string> {
  const tableIdent = `${qIdent(schema, "postgres")}.${qIdent(tableName, "postgres")}`;
  const res = await backupQuery(
    connectionId,
    `SELECT count(*)::text FROM ${tableIdent};`
  );
  const count = cellToString(res.rows?.[0]?.[0], true) ?? "";
  if (!/^\d+$/.test(count)) {
    throw new Error(
      `The rows of ${schema}.${tableName} could not be counted, so nothing was backed up.`
    );
  }
  if (count === "0") return "";
  return `INSERT INTO ${tableIdent} SELECT FROM generate_series(1, ${count});\n`;
}

export type PostgresTableStructure = {
  preDataSql: string;
  postDataSql: string;
  /** Stored generated columns: computed on restore, so not inserted. */
  generatedColumns: string[];
  /** A GENERATED ALWAYS identity column: inserts override it. */
  identityAlways: boolean;
  /** Every column is generated: rows are restored by count. */
  allGenerated: boolean;
  /** setval for owned sequences, run after the rows are restored. */
  sequenceValuesSql: string;
};

export async function buildPostgresTableStructure(args: {
  connectionId: string;
  schema: string;
  tableName: string;
}): Promise<PostgresTableStructure> {
  const { connectionId, schema, tableName } = args;
  const empty: PostgresTableStructure = {
    preDataSql: "",
    postDataSql: "",
    generatedColumns: [],
    identityAlways: false,
    allGenerated: false,
    sequenceValuesSql: "",
  };

  const oidRes = await backupQuery(
    connectionId,
    `
      SELECT c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${pgLiteral(schema)}
        AND c.relname = ${pgLiteral(tableName)}
        AND c.relkind IN ('r', 'p');
    `
  );

  const oid = Number(cellToString(oidRes.rows?.[0]?.[0], true));
  if (!Number.isFinite(oid) || oid <= 0) return empty;

  const colsRes = await backupQuery(
    connectionId,
    `
      SELECT
        a.attname,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr,
        a.attidentity::text,
        a.attgenerated::text
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ${oid}
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum;
    `
  );

  const tableIdent = `${qIdent(schema, "postgres")}.${qIdent(tableName, "postgres")}`;

  /**
   * The sequence a column owns (serial or identity): its options and where
   * it stands. Throws when it cannot be read: restoring the rows without
   * it would restart the numbering and collide with restored keys.
   */
  const readOwnedSequence = async (col: string) => {
    const sequenceFor = `pg_get_serial_sequence(${pgLiteral(tableIdent)}, ${pgLiteral(col)})`;
    try {
      const optRes = await backupQuery(
        connectionId,
        `
          SELECT ${sequenceFor}, s.seqstart::text, s.seqincrement::text,
            s.seqmin::text, s.seqmax::text, s.seqcache::text, s.seqcycle,
            pg_catalog.format_type(s.seqtypid, NULL)
          FROM pg_sequence s
          WHERE s.seqrelid = ${sequenceFor}::regclass;
        `
      );
      const r = optRes.rows?.[0] ?? [];
      // Already a quoted, schema-qualified name.
      const seq = cellToString(r[0], true) ?? "";
      const [start, inc, min, max, cache] = [1, 2, 3, 4, 5].map(
        (i) => cellToString(r[i], true) ?? ""
      );
      const type = cellToString(r[7], true) ?? "";
      const stateRes = await backupQuery(
        connectionId,
        `SELECT last_value::text, is_called FROM ${seq};`
      );
      const last = cellToString(stateRes.rows?.[0]?.[0], true) ?? "";
      const numbers = [start, inc, min, max, cache, last];
      if (!seq || !type || !numbers.every((n) => /^-?\d+$/.test(n))) {
        throw new Error("unexpected sequence state");
      }
      const cycle = cellToBool(r[6]) ? "CYCLE" : "NO CYCLE";
      return {
        sequenceFor,
        type,
        options:
          `INCREMENT BY ${inc} MINVALUE ${min} MAXVALUE ${max} START WITH ${start} ` +
          `CACHE ${cache} ${cycle}`,
        // The same options as ALTER TABLE … ALTER COLUMN … SET clauses.
        identitySet:
          `SET INCREMENT BY ${inc} SET MINVALUE ${min} SET MAXVALUE ${max} ` +
          `SET START WITH ${start} SET CACHE ${cache} SET ${cycle}`,
        setval: `SELECT pg_catalog.setval(${sequenceFor}, ${last}, ${cellToBool(stateRes.rows?.[0]?.[1]) ? "true" : "false"})`,
      };
    } catch {
      throw new Error(
        `The sequence numbering "${col}" of ${schema}.${tableName} could not be read (reading it needs SELECT on the sequence), so nothing was backed up: restored without it, the numbering would start over and collide with the restored rows.`
      );
    }
  };

  const generatedColumns: string[] = [];
  let identityAlways = false;
  let sequenceValuesSql = "";
  /**
   * Each owned sequence's options, set again after CREATE: a CREATE … IF
   * NOT EXISTS is skipped when the sequence or table already exists (a
   * restore over a table, or a sequence a domain default created first)
   * and would leave other options. RESTART: the rows and setval follow.
   */
  let sequenceOptionsSql = "";
  const columns: string[] = [];
  for (const r of (colsRes.rows ?? []) as any[]) {
    const name = cellToString(r?.[0]) ?? "";
    const dataType = cellToString(r?.[1]) ?? "";
    const notNull = cellToBool(r?.[2]);
    const expr = cellToString(r?.[3], true) ?? "";
    const identity = cellToString(r?.[4], true) ?? "";
    const generated = cellToString(r?.[5], true) ?? "";
    if (!name || !dataType) continue;
    const col = `  ${qIdent(name, "postgres")} ${dataType}`;
    const nn = notNull ? " NOT NULL" : "";
    // Generated columns (stored, or virtual on PostgreSQL 18) are computed
    // again on restore and never inserted.
    if (generated === "s" || generated === "v") {
      generatedColumns.push(name);
      columns.push(
        `${col} GENERATED ALWAYS AS (${expr}) ${generated === "s" ? "STORED" : "VIRTUAL"}${nn}`
      );
      continue;
    }
    // An identity column: its sequence is created with it, with its options.
    if (identity === "a" || identity === "d") {
      if (identity === "a") identityAlways = true;
      const seq = await readOwnedSequence(name);
      sequenceValuesSql += ensureSqlEndsWithSemicolon(seq.setval);
      sequenceOptionsSql += ensureSqlEndsWithSemicolon(
        `ALTER TABLE ${tableIdent} ALTER COLUMN ${qIdent(name, "postgres")} ${seq.identitySet} RESTART`
      );
      columns.push(
        `${col} GENERATED ${identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY (${seq.options})${nn}`
      );
      continue;
    }
    const defaultExpr = normalizePostgresDefaultExpr(expr);
    columns.push(`${col}${defaultExpr ? ` DEFAULT ${defaultExpr}` : ""}${nn}`);
  }

  if (columns.length === 0) return empty;

  const createTableSql =
    `CREATE TABLE IF NOT EXISTS ${tableIdent} (\n` +
    `${columns.join(",\n")}\n` +
    `);\n`;

  // Sequences used by column defaults (serial/bigserial) must exist before CREATE TABLE.
  const seqRes = await backupQuery(
    connectionId,
    `
      SELECT
        seq_ns.nspname AS seq_schema,
        seq.relname AS seq_name,
        col.attname AS col_name
      FROM pg_class tbl
      JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
      JOIN pg_attribute col ON col.attrelid = tbl.oid
      JOIN pg_depend dep
        ON dep.refobjid = tbl.oid
       AND dep.refobjsubid = col.attnum
       AND dep.deptype = 'a'
      JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
      JOIN pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
      WHERE tbl_ns.nspname = ${pgLiteral(schema)}
        AND tbl.relname = ${pgLiteral(tableName)}
        AND col.attnum > 0
        AND NOT col.attisdropped
      ORDER BY col.attnum;
    `
  );

  let sequenceCreateSql = "";
  let sequenceOwnedBySql = "";
  for (const row of seqRes.rows ?? []) {
    const seqSchema = cellToString(row?.[0]) ?? "";
    const seqName = cellToString(row?.[1]) ?? "";
    const colName = cellToString(row?.[2]) ?? "";
    if (!seqSchema || !seqName || !colName) continue;

    // Its options, and where it stands (set again after the rows).
    const seq = await readOwnedSequence(colName);
    sequenceValuesSql += ensureSqlEndsWithSemicolon(seq.setval);
    const seqIdent = `${qIdent(seqSchema, "postgres")}.${qIdent(seqName, "postgres")}`;
    sequenceCreateSql += ensureSqlEndsWithSemicolon(
      `CREATE SEQUENCE IF NOT EXISTS ${seqIdent} AS ${seq.type} ${seq.options}`
    );
    sequenceOwnedBySql += ensureSqlEndsWithSemicolon(
      `ALTER SEQUENCE ${seqIdent} OWNED BY ${tableIdent}.${qIdent(colName, "postgres")}`
    );
    sequenceOptionsSql += ensureSqlEndsWithSemicolon(
      `ALTER SEQUENCE ${seqIdent} AS ${seq.type} ${seq.options} RESTART`
    );
  }

  let preDataSql = `${sequenceCreateSql}${createTableSql}${sequenceOwnedBySql}${sequenceOptionsSql}`;

  const constraintsRes = await backupQuery(
    connectionId,
    `
      SELECT conname, contype, pg_get_constraintdef(oid, true)
      FROM pg_constraint
      WHERE conrelid = ${oid}
        AND contype IN ('p', 'u', 'f', 'c')
      ORDER BY
        CASE contype
          WHEN 'p' THEN 0
          WHEN 'u' THEN 1
          WHEN 'c' THEN 2
          ELSE 3
        END,
        conname;
    `
  );

  let postDataSql = "";
  for (const row of constraintsRes.rows ?? []) {
    const conName = cellToString(row?.[0]) ?? "";
    const conType = cellToString(row?.[1]) ?? "";
    const conDef = cellToString(row?.[2]) ?? "";
    if (!conName || !conDef) continue;

    const stmt = ensureSqlEndsWithSemicolon(
      `ALTER TABLE ${tableIdent} ADD CONSTRAINT ${qIdent(conName, "postgres")} ${conDef}`
    );
    if (!stmt) continue;

    if (conType === "f") postDataSql += stmt;
    else preDataSql += stmt;
  }

  const indexesRes = await backupQuery(
    connectionId,
    `
      SELECT pg_get_indexdef(i.indexrelid)
      FROM pg_index i
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
      WHERE ns.nspname = ${pgLiteral(schema)}
        AND tbl.relname = ${pgLiteral(tableName)}
        AND NOT i.indisprimary
        AND con.oid IS NULL;
    `
  );

  for (const row of indexesRes.rows ?? []) {
    const idxDef = cellToString(row?.[0]) ?? "";
    if (!idxDef) continue;
    postDataSql += ensureSqlEndsWithSemicolon(idxDef);
  }

  return {
    preDataSql,
    postDataSql,
    generatedColumns,
    identityAlways,
    allGenerated: generatedColumns.length === columns.length,
    sequenceValuesSql,
  };
}

export async function buildMysqlTableStructure(args: {
  connectionId: string;
  schema: string;
  tableName: string;
}): Promise<string> {
  const { connectionId, schema, tableName } = args;
  const tableIdent = `${qIdent(schema, "mysql")}.${qIdent(tableName, "mysql")}`;
  const res = await backupQuery(
    connectionId,
    `SHOW CREATE TABLE ${tableIdent};`
  );
  const createRaw = cellToString(res.rows?.[0]?.[1]) ?? "";
  if (!createRaw) return "";
  const createSql = createRaw.replace(
    /^CREATE TABLE\s+/i,
    "CREATE TABLE IF NOT EXISTS "
  );
  return ensureSqlEndsWithSemicolon(createSql);
}

/**
 * Engines whose backup holds the table structure (CREATE TABLE …) as well as
 * the rows. For the others it would hold rows only, which cannot be restored
 * into an empty database, so backup is not offered.
 */
export function canBackupDatabase(engine: string | undefined): boolean {
  return engine === "postgres" || engine === "mysql" || engine === "mariadb";
}
