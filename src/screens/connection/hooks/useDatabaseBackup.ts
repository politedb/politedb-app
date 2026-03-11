import { useCallback, useState } from "preact/hooks";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { CMD } from "src/lib/tauri/commands";
import { startSqlQueryStream, runSqlQuery } from "src/lib/tauri/query";
import { operationBus } from "src/lib/tauri/operationBus";
import { tableColumnsQuery, tableExportQuery, qIdent } from "src/hooks/queries";
import { cellToString } from "src/utils/convert";
import { splitSqlStatements } from "src/components/editor/splitSqlStatements";
import type { ConnectionCreateInput } from "src/lib/tauri";
import { useConnectionRuntimeCtx } from "../ConnectionRuntimeContext";

function sqlEscape(value: unknown): string {
  if (value == null) return "NULL";
  const s = String(value);
  return `'${s.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;
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
          invoke(CMD.exportAppendToFile, {
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

        const stamp = new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, "-");
        const dbName = databaseName || "database";
        const path = await save({
          title: "Backup database",
          defaultPath: `${dbName}-backup-${stamp}.sql`,
          filters: [{ name: "SQL", extensions: ["sql"] }],
        });
        if (!path) return;

        const header = [
          "-- PoliteDB database backup",
          `-- Engine: ${rt.engine}`,
          `-- Generated at: ${new Date().toISOString()}`,
          "",
        ].join("\n");

        await invoke(CMD.exportAppendToFile, {
          path,
          content: header,
          append: false,
        });

        for (const table of tables) {
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

          await invoke(CMD.exportAppendToFile, {
            path,
            content: `\n-- Table ${table.schema}.${table.name}\n`,
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

      const path = await open({
        title: "Restore database from SQL",
        multiple: false,
        directory: false,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });

      if (!path || typeof path !== "string") return;

      setDbRestoreRunning(true);

      try {
        const sql = await readTextFile(path);
        const statements = splitSqlStatements(sql);
        if (!statements.length) {
          throw new Error("No SQL statements found in selected file.");
        }

        const ok = window.confirm(
          `This will execute ${statements.length} SQL statements on current database. Continue?`
        );
        if (!ok) return;

        for (let i = 0; i < statements.length; i++) {
          await runSqlQuery(rt.runtimeConnectionId, statements[i].text, {
            timeoutMs: 120_000,
          });
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
