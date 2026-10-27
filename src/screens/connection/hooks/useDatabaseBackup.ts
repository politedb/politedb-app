import { useCallback, useState } from "preact/hooks";
import {
  confirmDialog,
  openDialog,
  saveDialog,
  showMessage,
} from "src/lib/system-dialog";
import { writeFile, readFile } from "src/lib/system-fs";

import { startSqlQueryStream, runSqlQuery } from "src/lib/tauri/query";
import { operationBus } from "src/lib/tauri/operationBus";
import {
  tableColumnsQuery,
  tableExportQuery,
  qIdent,
  qLiteral,
} from "src/lib/queries/sql";
import { cellToString } from "src/utils/convert";
import {
  splitDialectFor,
  splitSqlStatements,
} from "src/components/editor/splitSqlStatements";
import type { ConnectionCreateInput } from "src/lib/tauri";
import { useConnectionRuntimeCtx } from "../workspace/ConnectionRuntimeContext";
import { formatSqlInsertChunk, sqlQuoteString } from "./sqlInsertLiteral";
import { showToast } from "src/stores/toast";
import { useScreenStore } from "src/stores/screen";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import { dumpRunGate, tabSafetyModeNow } from "src/lib/dump/dumpRestoreSafety";
import {
  packSqlToDumb,
  unpackDumpBytes,
} from "src/lib/dump/politedbDumbFormat";

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

function cellToBool(cell: unknown): boolean {
  if (typeof cell === "boolean") return cell;
  if (cell && typeof cell === "object" && (cell as any).t === "Bool") {
    return Boolean((cell as any).v);
  }
  const s = String(cellToString(cell, true) ?? "").toLowerCase();
  return s === "true" || s === "t" || s === "1";
}

function ensureSqlEndsWithSemicolon(sql: string): string {
  const trimmed = (sql ?? "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith(";") ? `${trimmed}\n` : `${trimmed};\n`;
}

function normalizePostgresDefaultExpr(expr: string): string {
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

function parseBackupEngine(sql: string): string | null {
  const firstLines = sql.split(/\r?\n/, 20);
  for (const line of firstLines) {
    const m = line.match(/^--\s*Engine:\s*(.+)\s*$/i);
    if (m?.[1]) return m[1].trim().toLowerCase();
  }
  return null;
}

function normalizeEngineNameForCompare(engine: string): string {
  const e = engine.toLowerCase();
  if (e === "mariadb") return "mysql";
  return e;
}

function isIgnorableRestoreError(sql: string, err: unknown): boolean {
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
function clip(text: string, max: number): string {
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

function parsePgAlterAddConstraint(sql: string): {
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

function isPgAddForeignKeyStatement(sql: string): boolean {
  const s = sql.trim().toUpperCase();
  return (
    s.startsWith("ALTER TABLE") &&
    s.includes("ADD CONSTRAINT") &&
    s.includes("FOREIGN KEY")
  );
}

async function pgConstraintExists(args: {
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
      WHERE n.nspname = ${qLiteral(schema)}
        AND t.relname = ${qLiteral(table)}
        AND c.conname = ${qLiteral(constraint)}
      LIMIT 1;
    `,
    { timeoutMs: 30_000 }
  );

  return Boolean(res.rows?.length);
}

type BackupTable = {
  schema: string;
  name: string;
  kind?: string;
};

function tableNodeKey(t: { schema: string; name: string }) {
  return `${t.schema}.${t.name}`;
}

async function loadForeignKeyDeps(args: {
  connectionId: string;
  engine: string;
}): Promise<Array<{ child: string; parent: string }>> {
  const { connectionId, engine } = args;
  const e = engine.toLowerCase();

  if (e === "postgres") {
    const res = await runSqlQuery(
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
    const res = await runSqlQuery(
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

async function sortTablesByForeignKeys(args: {
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
 *   money as a number. Money inside a composite or range type cannot be
 *   written that way, so its backup stops (postgresMoneyColumns).
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
  const versionRes = await runSqlQuery(
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
  const res = await runSqlQuery(
    connectionId,
    `
      WITH RECURSIVE walk(attname, oid, steps, hops) AS (
        SELECT a.attname, a.atttypid, ''::text, 0
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${qLiteral(schema)}
          AND c.relname = ${qLiteral(tableName)}
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

/** Decimal places of money on this server (its lc_monetary). */
async function postgresMoneyScale(connectionId: string): Promise<number> {
  const res = await runSqlQuery(
    connectionId,
    "SELECT scale('0'::money::numeric);"
  );
  const scale = Number(cellToString(res.rows?.[0]?.[0], true));
  return Number.isInteger(scale) && scale >= 0 ? scale : 2;
}

/**
 * A restore statement that stops before a table's money rows when the
 * target's currency locale keeps fewer decimal places than the backed-up
 * amounts have: converting them to money there would round them.
 */
export function postgresMoneyScaleGuard(scale: number): string {
  return (
    "DO $politedb$ BEGIN\n" +
    `  IF scale('0'::money::numeric) < ${scale} THEN\n` +
    `    RAISE EXCEPTION 'This backup holds money amounts with ${scale} decimal places, but money on this server has %. Restore into a database whose lc_monetary keeps ${scale}.', scale('0'::money::numeric);\n` +
    "  END IF;\n" +
    "END $politedb$;\n"
  );
}

async function exportTableToSqlParts(args: {
  append: (content: string) => void;
  connectionId: string;
  engine: ConnectionCreateInput["engine"];
  schema: string;
  tableName: string;
  columns: string[];
}) {
  const { append, connectionId, engine, schema, tableName, columns } = args;

  const money =
    engine === "postgres"
      ? await postgresMoneyColumns(connectionId, schema, tableName)
      : null;
  const query = money
    ? postgresBackupRowsQuery(schema, tableName, columns, money)
    : tableExportQuery(schema, tableName, columns, undefined, "AND", engine);
  if (money && (money.scalar.size > 0 || money.array.size > 0)) {
    append(postgresMoneyScaleGuard(await postgresMoneyScale(connectionId)));
  }
  const opId = await startSqlQueryStream(connectionId, query, {
    batchSize: 250,
    maxRows: 10_000_000,
    canonicalTextOutput: engine === "postgres",
  });

  await new Promise<void>((resolve, reject) => {
    let completed = false;
    let columnNames = columns;
    let columnTypes: string[] = columns.map(() => "");

    const done = () => {
      if (completed) return;
      completed = true;
      resolve();
    };

    const fail = (err: unknown) => {
      if (completed) return;
      completed = true;
      reject(err);
    };

    void operationBus.subscribe(opId, {
      onChunk: (chunk) => {
        const rows = chunk.rows ?? [];
        if (!rows.length) return;

        if (chunk.columns?.length) {
          columnNames = chunk.columns.map((c) => c.name).filter(Boolean);
          columnTypes = chunk.columns.map((c) => String(c.db_type ?? ""));
          // Money read as numeric is written as a typed numeric.
          if (money) {
            columnTypes = columnTypes.map((type, i) =>
              money.scalar.has(columnNames[i]!)
                ? "numeric"
                : money.array.has(columnNames[i]!)
                  ? "numeric[]"
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
        });
        if (!content) return;
        append(content);
      },
      onDone: () => done(),
      onError: (err) => {
        fail(
          typeof err === "string" ? new Error(err) : (err ?? "EXPORT_FAILED")
        );
      },
    });
  });
}

type PgTypeRow = {
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
function createCollationSql(
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
    .map((t) => `(${qLiteral(t.schema)}, ${qLiteral(t.name)})`)
    .join(", ");
  const res = await runSqlQuery(
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

async function buildPostgresTableStructure(args: {
  connectionId: string;
  schema: string;
  tableName: string;
}): Promise<{ preDataSql: string; postDataSql: string }> {
  const { connectionId, schema, tableName } = args;

  const oidRes = await runSqlQuery(
    connectionId,
    `
      SELECT c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${qLiteral(schema)}
        AND c.relname = ${qLiteral(tableName)}
        AND c.relkind IN ('r', 'p');
    `
  );

  const oid = Number(cellToString(oidRes.rows?.[0]?.[0], true));
  if (!Number.isFinite(oid) || oid <= 0) {
    return { preDataSql: "", postDataSql: "" };
  }

  const colsRes = await runSqlQuery(
    connectionId,
    `
      SELECT
        a.attname,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ${oid}
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum;
    `
  );

  const columns = (colsRes.rows ?? [])
    .map((r: any) => {
      const name = cellToString(r?.[0]) ?? "";
      const dataType = cellToString(r?.[1]) ?? "";
      const notNull = cellToBool(r?.[2]);
      const defaultExpr = normalizePostgresDefaultExpr(
        cellToString(r?.[3], true) ?? ""
      );
      if (!name || !dataType) return "";
      return `  ${qIdent(name, "postgres")} ${dataType}${defaultExpr ? ` DEFAULT ${defaultExpr}` : ""}${notNull ? " NOT NULL" : ""}`;
    })
    .filter(Boolean);

  if (columns.length === 0) {
    return { preDataSql: "", postDataSql: "" };
  }

  const tableIdent = `${qIdent(schema, "postgres")}.${qIdent(tableName, "postgres")}`;
  const createTableSql =
    `CREATE TABLE IF NOT EXISTS ${tableIdent} (\n` +
    `${columns.join(",\n")}\n` +
    `);\n`;

  // Sequences used by column defaults (serial/bigserial) must exist before CREATE TABLE.
  const seqRes = await runSqlQuery(
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
      WHERE tbl_ns.nspname = ${qLiteral(schema)}
        AND tbl.relname = ${qLiteral(tableName)}
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

    const seqIdent = `${qIdent(seqSchema, "postgres")}.${qIdent(seqName, "postgres")}`;
    sequenceCreateSql += ensureSqlEndsWithSemicolon(
      `CREATE SEQUENCE IF NOT EXISTS ${seqIdent}`
    );
    sequenceOwnedBySql += ensureSqlEndsWithSemicolon(
      `ALTER SEQUENCE ${seqIdent} OWNED BY ${tableIdent}.${qIdent(colName, "postgres")}`
    );
  }

  let preDataSql = `${sequenceCreateSql}${createTableSql}${sequenceOwnedBySql}`;

  const constraintsRes = await runSqlQuery(
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

  const indexesRes = await runSqlQuery(
    connectionId,
    `
      SELECT pg_get_indexdef(i.indexrelid)
      FROM pg_index i
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
      WHERE ns.nspname = ${qLiteral(schema)}
        AND tbl.relname = ${qLiteral(tableName)}
        AND NOT i.indisprimary
        AND con.oid IS NULL;
    `
  );

  for (const row of indexesRes.rows ?? []) {
    const idxDef = cellToString(row?.[0]) ?? "";
    if (!idxDef) continue;
    postDataSql += ensureSqlEndsWithSemicolon(idxDef);
  }

  return { preDataSql, postDataSql };
}

async function buildMysqlTableStructure(args: {
  connectionId: string;
  schema: string;
  tableName: string;
}): Promise<string> {
  const { connectionId, schema, tableName } = args;
  const tableIdent = `${qIdent(schema, "mysql")}.${qIdent(tableName, "mysql")}`;
  const res = await runSqlQuery(
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

export function useDatabaseBackup() {
  const rt = useConnectionRuntimeCtx();
  const [dbBackupRunning, setDbBackupRunning] = useState(false);
  const [dbRestoreRunning, setDbRestoreRunning] = useState(false);

  const onBackupDatabase = useCallback(
    async (databaseName?: string) => {
      if (!rt.runtimeConnectionId) return;
      if (!canBackupDatabase(rt.engine)) {
        void showMessage(
          "Database backup is available for PostgreSQL, MySQL and MariaDB.",
          { title: "Backup database", kind: "info" }
        );
        return;
      }

      setDbBackupRunning(true);

      try {
        const meta = await rt.metadata.load({
          metaKey: rt.metaKey,
          engine: rt.engine,
          connectionId: rt.runtimeConnectionId,
        });

        const tables = (meta.tables ?? []).filter((t) => t.kind !== "view");
        if (!tables.length) {
          throw new Error("No tables found to backup.");
        }
        const orderedTables = await sortTablesByForeignKeys({
          connectionId: rt.runtimeConnectionId,
          engine: rt.engine,
          tables,
        });

        const stamp = new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, "");
        const dbName = databaseName || "database";
        const path = await saveDialog({
          title: "Backup database",
          defaultPath: `${dbName}-backup-${stamp}.dumb`,
          filters: [{ name: "PoliteDB dump", extensions: ["dumb"] }],
        });
        if (!path) return;

        const sqlParts: string[] = [];
        const appendSql = (content: string) => {
          if (content) sqlParts.push(content);
        };

        const header = [
          "-- PoliteDB database backup",
          `-- Engine: ${rt.engine}`,
          `-- Generated at: ${new Date().toISOString()}`,
          "-- Sections: structure, data",
          "",
        ].join("\n");

        appendSql(header);

        const postDataSqlChunks: string[] = [];
        const preDataByTable = new Map<string, string>();
        const columnsByTable = new Map<string, string[]>();

        if (rt.engine === "mysql" || rt.engine === "mariadb") {
          appendSql("\nSET FOREIGN_KEY_CHECKS = 0;\n");
        }

        for (const table of orderedTables) {
          let structureSql = "";
          let postDataSql = "";

          if (rt.engine === "postgres") {
            const pgStruct = await buildPostgresTableStructure({
              connectionId: rt.runtimeConnectionId,
              schema: table.schema,
              tableName: table.name,
            });
            structureSql = pgStruct.preDataSql;
            postDataSql = pgStruct.postDataSql;
          } else if (rt.engine === "mysql" || rt.engine === "mariadb") {
            structureSql = await buildMysqlTableStructure({
              connectionId: rt.runtimeConnectionId,
              schema: table.schema,
              tableName: table.name,
            });
          }

          if (structureSql) {
            preDataByTable.set(`${table.schema}.${table.name}`, structureSql);
          }

          if (postDataSql) {
            postDataSqlChunks.push(
              `\n-- Post-data ${dumpCommentName(table.schema, table.name)}\n${postDataSql}`
            );
          }

          const key = `${table.schema}.${table.name}`;
          let columns = meta.columnsByTable[key] ?? [];

          if (!columns.length) {
            const colRes = await runSqlQuery(
              rt.runtimeConnectionId,
              tableColumnsQuery(table.schema, table.name)
            );
            columns = (colRes.rows ?? [])
              .map((r: any) => cellToString(r?.[0]) ?? "")
              .filter(Boolean);
          }

          if (!columns.length) continue;
          columnsByTable.set(key, columns);
        }

        // Phase 0: schemas and the types the tables use (PostgreSQL)
        if (rt.engine === "postgres") {
          const typesSql = await buildPostgresTypesSql({
            connectionId: rt.runtimeConnectionId,
            tables: orderedTables,
          });
          if (typesSql) appendSql(`\n-- Schemas and types\n${typesSql}`);
        }

        // Phase 1: create all tables (and non-FK constraints)
        for (const table of orderedTables) {
          const key = `${table.schema}.${table.name}`;
          const structureSql = preDataByTable.get(key) ?? "";
          if (!structureSql) continue;
          appendSql(
            `\n-- Structure ${dumpCommentName(table.schema, table.name)}\n${structureSql}`
          );
        }

        // Phase 2: insert data for all tables
        for (const table of orderedTables) {
          const key = `${table.schema}.${table.name}`;
          const columns = columnsByTable.get(key) ?? [];
          if (!columns.length) continue;

          appendSql(`\n-- Data ${dumpCommentName(table.schema, table.name)}\n`);

          await exportTableToSqlParts({
            append: appendSql,
            connectionId: rt.runtimeConnectionId,
            engine: rt.engine,
            schema: table.schema,
            tableName: table.name,
            columns,
          });
        }

        if (postDataSqlChunks.length > 0) {
          appendSql(
            `\n-- Post-data constraints/indexes\n${postDataSqlChunks.join("\n")}`
          );
        }

        if (rt.engine === "mysql" || rt.engine === "mariadb") {
          appendSql("\nSET FOREIGN_KEY_CHECKS = 1;\n");
        }

        const sql = sqlParts.join("");
        const dumbBytes = await packSqlToDumb({
          sql,
          engine: rt.engine,
        });
        await writeFile(path, dumbBytes);

        showToast("Database backup completed.", { tone: "success" });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Backup database failed.";
        void showMessage(message, { title: "Backup error", kind: "error" });
      } finally {
        setDbBackupRunning(false);
      }
    },
    [rt.runtimeConnectionId, rt.metadata, rt.metaKey, rt.engine]
  );

  const runSqlDumpImport = useCallback(
    async (
      onRefresh: (() => void) | undefined,
      opts: {
        action: "restore" | "import";
        dialogTitle: string;
        successToast: string;
        /** The tab whose safety mode applies; the active one by default. */
        tabId?: string;
        /** The database the dump goes into, named in the confirmation. */
        database?: string;
      }
    ) => {
      if (!rt.runtimeConnectionId) return;
      const { action } = opts;
      const tabId = opts.tabId ?? rt.profileId;
      const errorTitle =
        action === "restore" ? "Restore error" : "Import error";

      // Lock and Production refuse before a file is even chosen…
      const early = dumpRunGate(tabSafetyModeNow(tabId), action);
      if (early.kind === "blocked") {
        void showMessage(early.message, { title: errorTitle, kind: "warning" });
        return;
      }

      const path = await openDialog({
        title: opts.dialogTitle,
        multiple: false,
        directory: false,
        filters: [
          { name: "PoliteDB dump", extensions: ["dumb"] },
          { name: "SQL", extensions: ["sql"] },
        ],
      });

      if (!path || typeof path !== "string") return;

      setDbRestoreRunning(true);

      let applied = 0;
      try {
        const fileBytes = await readFile(path);
        const unpacked = await unpackDumpBytes(fileBytes);
        const sql = unpacked.sql;

        const backupEngine = unpacked.engine ?? parseBackupEngine(sql) ?? null;
        if (backupEngine) {
          const dumpEngine = normalizeEngineNameForCompare(backupEngine);
          const currentEngine = normalizeEngineNameForCompare(rt.engine);
          if (dumpEngine !== currentEngine) {
            throw new Error(
              `Backup engine mismatch: file is '${backupEngine}', current connection is '${rt.engine}'.`
            );
          }
        }

        // Split by the engine's own quoting rules: read the PostgreSQL way,
        // a backslash in a string is text, and data can never end a string
        // early and turn the rest into statements.
        const statements = splitSqlStatements(sql, {
          dialect: splitDialectFor(rt.engine),
        })
          .map((statement) => statement.text.trim())
          .filter(Boolean);
        if (!statements.length) {
          throw new Error("No SQL statements found in selected file.");
        }

        const tab = useScreenStore
          .getState()
          .profileTabs.find((item) => item.id === tabId);
        const target = [tab?.label, opts.database ? `(${opts.database})` : ""]
          .filter(Boolean)
          .join(" ");
        const fileName = path.split(/[\\/]/).pop() || path;
        const verb = action === "restore" ? "Restore" : "Import";
        const ok = await confirmDialog(
          `${verb} "${fileName}"${target ? ` into ${target}` : ""}?\n\nThis runs ${statements.length} SQL statement${statements.length === 1 ? "" : "s"} on the database. They do not run in a transaction and cannot be undone.`,
          {
            title: opts.dialogTitle,
            kind: "warning",
            okLabel: verb,
            cancelLabel: "Cancel",
          }
        );
        if (!ok) return;

        // …and checked again before every statement, on the originating
        // tab's live mode: it may change during the confirmation, Touch ID
        // or the run itself. Touch ID is asked once, when first needed.
        let authenticated = false;
        const ensureAllowed = async (): Promise<string | null> => {
          for (;;) {
            const gate = dumpRunGate(
              tabSafetyModeNow(tabId),
              action,
              applied > 0
            );
            if (gate.kind === "blocked") return gate.message;
            if (gate.kind === "run" || authenticated) return null;
            try {
              await securityTouchIdAuthenticate(gate.prompt);
              authenticated = true;
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              return `Touch ID authentication failed, so ${applied > 0 ? "nothing more" : "nothing"} was run: ${reason}`;
            }
          }
        };
        const describeApplied = () =>
          applied === 0
            ? "Nothing before it had changed the database."
            : applied === 1
              ? "The statement before it already ran and stays in the database."
              : `The ${applied} statements before it already ran and stay in the database.`;

        const refused = await ensureAllowed();
        if (refused) {
          void showMessage(refused, { title: errorTitle, kind: "warning" });
          return;
        }

        let skipped = 0;
        let stopped: { message: string; index: number } | null = null;
        for (let i = 0; i < statements.length; i++) {
          const statementSql = statements[i]!;

          try {
            if (rt.engine === "postgres") {
              const parsed = parsePgAlterAddConstraint(statementSql);
              if (parsed) {
                const exists = await pgConstraintExists({
                  connectionId: rt.runtimeConnectionId,
                  schema: parsed.schema,
                  table: parsed.table,
                  constraint: parsed.constraint,
                });
                if (exists) {
                  skipped++;
                  continue;
                }
              }
            }

            const blocked = await ensureAllowed();
            if (blocked) {
              stopped = { message: blocked, index: i };
              break;
            }

            await runSqlQuery(rt.runtimeConnectionId, statementSql, {
              timeoutMs: 120_000,
            });
            applied++;
          } catch (err) {
            if (
              rt.engine === "postgres" &&
              isPgAddForeignKeyStatement(statementSql)
            ) {
              // Keep restore progressing even if existing data violates FK
              // or FK already exists with incompatible shape.
              skipped++;
              continue;
            }

            if (isIgnorableRestoreError(statementSql, err)) {
              skipped++;
              continue;
            }

            const reason = restoreErrorSummary(err);
            throw new Error(
              `Stopped at statement ${i + 1} of ${statements.length}: ${reason}\n\n${describeApplied()}\n\nStatement: ${restoreStatementLabel(statementSql)}`
            );
          }
        }

        if (stopped) {
          // What already ran is in the database: show it.
          if (applied > 0) {
            await rt.refreshSchemaAndTables();
            onRefresh?.();
          }
          void showMessage(
            `${stopped.message}\nStopped before statement ${stopped.index + 1} of ${statements.length}. ${describeApplied()}`,
            { title: errorTitle, kind: "warning" }
          );
          return;
        }

        await rt.refreshSchemaAndTables();
        onRefresh?.();
        if (skipped > 0) {
          showToast(
            `${opts.successToast} ${skipped} statement${skipped === 1 ? " was" : "s were"} skipped: objects that already existed or foreign keys the data did not allow.`,
            { tone: "info" }
          );
        } else {
          showToast(opts.successToast, { tone: "success" });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "SQL dump import failed.";
        void showMessage(message, { title: errorTitle, kind: "error" });
      } finally {
        setDbRestoreRunning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt.runtimeConnectionId, rt.refreshSchemaAndTables, rt.profileId, rt.engine]
  );

  const onRestoreDatabase = useCallback(
    async (onRefresh?: () => void, database?: string) => {
      await runSqlDumpImport(onRefresh, {
        action: "restore",
        dialogTitle: "Restore database from dump",
        successToast: "Database restored.",
        database,
      });
    },
    [runSqlDumpImport]
  );

  // Table-level SQL dump import, like database backup and restore, is free.
  const onImportSqlDump = useCallback(
    async (onRefresh?: () => void, opts?: { tabId?: string }) => {
      await runSqlDumpImport(onRefresh, {
        action: "import",
        dialogTitle: "Import SQL dump",
        successToast: "SQL dump imported.",
        tabId: opts?.tabId,
      });
    },
    [runSqlDumpImport]
  );

  return {
    dbBackupRunning,
    dbRestoreRunning,
    onBackupDatabase,
    onRestoreDatabase,
    onImportSqlDump,
  };
}
