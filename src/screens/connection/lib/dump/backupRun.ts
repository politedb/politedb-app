import { saveDialog, showMessage } from "src/lib/system-dialog";
import { writeFile } from "src/lib/system-fs";
import { sqlSessionBegin, sqlSessionEnd } from "src/lib/tauri/sqlSession";
import { tableColumnsQuery } from "src/lib/queries/sql";
import { cellToString } from "src/utils/convert";
import { showToast } from "src/stores/toast";
import { packSqlToDumb } from "src/lib/dump/politedbDumbFormat";
import type { useConnectionRuntimeCtx } from "../../workspace/ConnectionRuntimeContext";
import {
  backupQuery,
  backupSnapshots,
  buildMysqlTableStructure,
  buildPostgresTableStructure,
  buildPostgresTypesSql,
  canBackupDatabase,
  dumpCommentName,
  exportTableToSqlParts,
  postgresGeneratedOnlyRowsSql,
  postgresSnapshotColumns,
  postgresSnapshotTables,
  sortTablesByForeignKeys,
  type BackupTable,
} from "./backupSql";

type Runtime = ReturnType<typeof useConnectionRuntimeCtx>;

/** Backs up the connection's database into a .dumb file the user picks. */
export async function runDatabaseBackup(
  rt: Pick<Runtime, "runtimeConnectionId" | "engine" | "metadata" | "metaKey">,
  databaseName: string | undefined,
  setRunning: (running: boolean) => void
): Promise<void> {
  if (!rt.runtimeConnectionId) return;
  if (!canBackupDatabase(rt.engine)) {
    void showMessage(
      "Database backup is available for PostgreSQL, MySQL and MariaDB.",
      { title: "Backup database", kind: "info" }
    );
    return;
  }

  // One backup per connection at a time, reserved before anything is
  // awaited; each reads its own snapshot (backupSnapshots).
  const connectionId = rt.runtimeConnectionId;
  if (backupSnapshots.has(connectionId)) {
    void showMessage("A backup of this connection is already running.", {
      title: "Backup database",
      kind: "info",
    });
    return;
  }
  const run: { snapshotId: string | null } = { snapshotId: null };
  backupSnapshots.set(connectionId, run);

  setRunning(true);

  let snapshotSessionId: string | null = null;
  try {
    const meta = await rt.metadata.load({
      metaKey: rt.metaKey,
      engine: rt.engine,
      connectionId,
    });

    let tables: BackupTable[] = (meta.tables ?? []).filter(
      (t) => t.kind !== "view"
    );
    // PostgreSQL reads its tables through the snapshot below.
    if (!tables.length && rt.engine !== "postgres") {
      throw new Error("No tables found to backup.");
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
    const dbName = databaseName || "database";
    const path = await saveDialog({
      title: "Backup database",
      defaultPath: `${dbName}-backup-${stamp}.dumb`,
      filters: [{ name: "PoliteDB dump", extensions: ["dumb"] }],
    });
    if (!path) return;

    // PostgreSQL: every query of the backup reads one snapshot, so the
    // tables, their rows and sequences agree even while others write.
    // The tables and their columns are read through it too: the
    // workspace's lists may predate it.
    if (rt.engine === "postgres") {
      const session = await sqlSessionBegin(connectionId, "snapshot");
      snapshotSessionId = session.sessionId;
      if (!session.snapshotId) {
        throw new Error("No snapshot to back up from.");
      }
      run.snapshotId = session.snapshotId;
      tables = await postgresSnapshotTables(connectionId);
      if (!tables.length) {
        throw new Error("No tables found to backup.");
      }
    }
    const orderedTables = await sortTablesByForeignKeys({
      connectionId: rt.runtimeConnectionId,
      engine: rt.engine,
      tables,
    });

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
    const identityAlwaysTables = new Set<string>();
    // Tables whose columns are all generated: no column to insert.
    const generatedOnlyTables = new Set<string>();

    if (rt.engine === "mysql" || rt.engine === "mariadb") {
      appendSql("\nSET FOREIGN_KEY_CHECKS = 0;\n");
    }

    for (const table of orderedTables) {
      let structureSql = "";
      let postDataSql = "";
      let generatedColumns: string[] = [];

      if (rt.engine === "postgres") {
        const pgStruct = await buildPostgresTableStructure({
          connectionId: rt.runtimeConnectionId,
          schema: table.schema,
          tableName: table.name,
        });
        structureSql = pgStruct.preDataSql;
        // Sequences are set after every table's rows, with the rest.
        postDataSql = pgStruct.postDataSql + pgStruct.sequenceValuesSql;
        generatedColumns = pgStruct.generatedColumns;
        if (pgStruct.identityAlways) {
          identityAlwaysTables.add(`${table.schema}.${table.name}`);
        }
        if (pgStruct.allGenerated) {
          generatedOnlyTables.add(`${table.schema}.${table.name}`);
        }
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
      let columns =
        rt.engine === "postgres"
          ? await postgresSnapshotColumns(
              rt.runtimeConnectionId,
              table.schema,
              table.name
            )
          : (meta.columnsByTable[key] ?? []);

      if (!columns.length) {
        const colRes = await backupQuery(
          rt.runtimeConnectionId,
          tableColumnsQuery(table.schema, table.name)
        );
        columns = (colRes.rows ?? [])
          .map((r: any) => cellToString(r?.[0]) ?? "")
          .filter(Boolean);
      }

      // Generated columns are computed again on restore.
      columns = columns.filter((c) => !generatedColumns.includes(c));
      if (!columns.length && !generatedOnlyTables.has(key)) continue;
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
      if (!columns.length && !generatedOnlyTables.has(key)) continue;

      appendSql(`\n-- Data ${dumpCommentName(table.schema, table.name)}\n`);

      // Every column is generated: the rows are restored by count.
      if (!columns.length) {
        appendSql(
          await postgresGeneratedOnlyRowsSql(
            rt.runtimeConnectionId,
            table.schema,
            table.name
          )
        );
        continue;
      }

      await exportTableToSqlParts({
        append: appendSql,
        connectionId: rt.runtimeConnectionId,
        engine: rt.engine,
        schema: table.schema,
        tableName: table.name,
        columns,
        overridingSystemValue: identityAlwaysTables.has(key),
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
    // Only this run's own reservation.
    if (backupSnapshots.get(connectionId) === run) {
      backupSnapshots.delete(connectionId);
    }
    if (snapshotSessionId) {
      // Read only: nothing to keep.
      void sqlSessionEnd(snapshotSessionId, false).catch(() => {});
    }
    setRunning(false);
  }
}
