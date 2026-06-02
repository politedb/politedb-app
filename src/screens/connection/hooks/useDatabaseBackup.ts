import { useCallback, useState } from "preact/hooks";
import { openDialog, saveDialog } from "src/lib/system-dialog";
import { readTextFile } from "src/lib/system-fs";

import { exportAppendToFile } from "src/lib/tauri/export";
import { startSqlQueryStream, runSqlQuery } from "src/lib/tauri/query";
import { operationBus } from "src/lib/tauri/operationBus";
import {
  tableColumnsQuery,
  tableExportQuery,
  qIdent,
  qLiteral,
} from "src/lib/queries/sql";
import { cellToString } from "src/utils/convert";
import { splitSqlStatements } from "src/components/editor/splitSqlStatements";
import type { ConnectionCreateInput } from "src/lib/tauri";
import { useConnectionRuntimeCtx } from "../ConnectionRuntimeContext";

function sqlEscape(value: unknown): string {
  if (value == null) return "NULL";
  const s = String(value);
  return `'${s.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;
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
  const msg = String(
    err instanceof Error ? err.message : err ?? ""
  ).toLowerCase();

  const isDdl =
    stmt.startsWith("CREATE TABLE") ||
    stmt.startsWith("CREATE SCHEMA") ||
    stmt.startsWith("CREATE INDEX") ||
    stmt.startsWith("ALTER TABLE");

  if (!isDdl) return false;

  return (
    msg.includes("already exists") ||
    msg.includes("already a primary key") ||
    msg.includes("multiple primary keys") ||
    msg.includes("constraint") && msg.includes("already") ||
    msg.includes("duplicate key name") ||
    msg.includes("duplicate object")
  );
}

function shortSql(sql: string, max = 260): string {
  const s = sql.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
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
    nexts.sort((a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));
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
    missing.sort((a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));
    orderedKeys.push(...missing);
  }

  const byKey = new Map(tables.map((t) => [tableNodeKey(t), t] as const));
  return orderedKeys
    .map((k) => byKey.get(k))
    .filter(Boolean) as BackupTable[];
}

function formatSqlInsertChunk(args: {
  engine: ConnectionCreateInput["engine"];
  schema: string;
  tableName: string;
  columnNames: string[];
  rows: unknown[][];
}): string {
  const { engine, schema, tableName, columnNames, rows } = args;
  if (!rows.length) return "";

  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;
  const colList = columnNames.map((c) => qIdent(c, engine)).join(", ");
  const values = rows
    .map((row) => {
      const cells = row.map((cell) => sqlEscape(cellToString(cell, true)));
      return `  (${cells.join(", ")})`;
    })
    .join(",\n");

  return `INSERT INTO ${tableIdent} (${colList}) VALUES\n${values};\n`;
}

async function exportTableToSqlFile(args: {
  path: string;
  connectionId: string;
  engine: ConnectionCreateInput["engine"];
  schema: string;
  tableName: string;
  columns: string[];
}) {
  const { path, connectionId, engine, schema, tableName, columns } = args;

  const query = tableExportQuery(
    schema,
    tableName,
    columns,
    undefined,
    "AND",
    engine
  );
  const opId = await startSqlQueryStream(connectionId, query, {
    batchSize: 250,
    maxRows: 10_000_000,
  });

  await new Promise<void>((resolve, reject) => {
    let writeQueue = Promise.resolve();
    let completed = false;

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

        const chunkColumns =
          chunk.columns?.map((c) => c.name).filter(Boolean) ?? columns;
        const content = formatSqlInsertChunk({
          engine,
          schema,
          tableName,
          columnNames: chunkColumns,
          rows,
        });
        if (!content) return;

        writeQueue = writeQueue.then(() =>
          exportAppendToFile( {
            path,
            content,
            append: true,
          })
        );
      },
      onDone: async () => {
        try {
          await writeQueue;
          done();
        } catch (e) {
          fail(e);
        }
      },
      onError: (err) => {
        fail(
          typeof err === "string" ? new Error(err) : (err ?? "EXPORT_FAILED")
        );
      },
    });
  });
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

export function useDatabaseBackup() {
  const rt = useConnectionRuntimeCtx();
  const [dbBackupRunning, setDbBackupRunning] = useState(false);
  const [dbRestoreRunning, setDbRestoreRunning] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const onBackupDatabase = useCallback(
    async (databaseName?: string) => {
      if (!rt.runtimeConnectionId) return;

      setOpError(null);
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
          defaultPath: `${dbName}-backup-${stamp}.sql`,
          filters: [{ name: "SQL", extensions: ["sql"] }],
        });
        if (!path) return;

        const header = [
          "-- PoliteDB database backup",
          `-- Engine: ${rt.engine}`,
          `-- Generated at: ${new Date().toISOString()}`,
          "-- Sections: structure, data",
          "",
        ].join("\n");

        await exportAppendToFile( {
          path,
          content: header,
          append: false,
        });

        const postDataSqlChunks: string[] = [];
        const preDataByTable = new Map<string, string>();
        const columnsByTable = new Map<string, string[]>();

        if (rt.engine === "mysql" || rt.engine === "mariadb") {
          await exportAppendToFile( {
            path,
            content: "\nSET FOREIGN_KEY_CHECKS = 0;\n",
            append: true,
          });
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
              `\n-- Post-data ${table.schema}.${table.name}\n${postDataSql}`
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

        // Phase 1: create all tables (and non-FK constraints)
        for (const table of orderedTables) {
          const key = `${table.schema}.${table.name}`;
          const structureSql = preDataByTable.get(key) ?? "";
          if (!structureSql) continue;
          await exportAppendToFile( {
            path,
            content: `\n-- Structure ${table.schema}.${table.name}\n${structureSql}`,
            append: true,
          });
        }

        // Phase 2: insert data for all tables
        for (const table of orderedTables) {
          const key = `${table.schema}.${table.name}`;
          const columns = columnsByTable.get(key) ?? [];
          if (!columns.length) continue;

          await exportAppendToFile( {
            path,
            content: `\n-- Data ${table.schema}.${table.name}\n`,
            append: true,
          });

          await exportTableToSqlFile({
            path,
            connectionId: rt.runtimeConnectionId,
            engine: rt.engine,
            schema: table.schema,
            tableName: table.name,
            columns,
          });
        }

        if (postDataSqlChunks.length > 0) {
          await exportAppendToFile( {
            path,
            content: `\n-- Post-data constraints/indexes\n${postDataSqlChunks.join("\n")}`,
            append: true,
          });
        }

        if (rt.engine === "mysql" || rt.engine === "mariadb") {
          await exportAppendToFile( {
            path,
            content: "\nSET FOREIGN_KEY_CHECKS = 1;\n",
            append: true,
          });
        }
      } catch (err) {
        setOpError(
          err instanceof Error ? err.message : "Backup database failed."
        );
      } finally {
        setDbBackupRunning(false);
      }
    },
    [rt.runtimeConnectionId, rt.metadata, rt.metaKey, rt.engine]
  );

  const onRestoreDatabase = useCallback(
    async (onRefresh?: () => void) => {
      if (!rt.runtimeConnectionId) return;

      setOpError(null);

      const path = await openDialog({
        title: "Restore database from SQL",
        multiple: false,
        directory: false,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });

      if (!path || typeof path !== "string") return;

      setDbRestoreRunning(true);

      try {
        const sql = await readTextFile(path);
        const backupEngine = parseBackupEngine(sql);
        if (backupEngine) {
          const dumpEngine = normalizeEngineNameForCompare(backupEngine);
          const currentEngine = normalizeEngineNameForCompare(rt.engine);
          if (dumpEngine !== currentEngine) {
            throw new Error(
              `Backup engine mismatch: file is '${backupEngine}', current connection is '${rt.engine}'.`
            );
          }
        }

        const statements = splitSqlStatements(sql);
        if (!statements.length) {
          throw new Error("No SQL statements found in selected file.");
        }

        const ok = window.confirm(
          `This will execute ${statements.length} SQL statements on current database. Continue?`
        );
        if (!ok) return;

        for (let i = 0; i < statements.length; i++) {
          const statementSql = statements[i].text.trim();
          if (!statementSql) continue;

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
                if (exists) continue;
              }
            }

            await runSqlQuery(rt.runtimeConnectionId, statementSql, {
              timeoutMs: 120_000,
            });
          } catch (err) {
            if (
              rt.engine === "postgres" &&
              isPgAddForeignKeyStatement(statementSql)
            ) {
              // Keep restore progressing even if existing data violates FK
              // or FK already exists with incompatible shape.
              continue;
            }

            if (isIgnorableRestoreError(statementSql, err)) {
              continue;
            }

            const reason =
              err instanceof Error ? err.message : "Unknown restore error";
            throw new Error(
              `Restore failed at statement ${i + 1}/${statements.length}: ${reason}\nSQL: ${shortSql(statementSql)}`
            );
          }
        }

        await rt.refreshSchemaAndTables();
        onRefresh?.();
      } catch (err) {
        setOpError(
          err instanceof Error ? err.message : "Restore database failed."
        );
      } finally {
        setDbRestoreRunning(false);
      }
    },
    [rt.runtimeConnectionId, rt.refreshSchemaAndTables]
  );

  return {
    dbBackupRunning,
    dbRestoreRunning,
    opError,
    setOpError,
    onBackupDatabase,
    onRestoreDatabase,
  };
}
