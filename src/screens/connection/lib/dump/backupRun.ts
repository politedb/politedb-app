import { sqlSessionBegin, sqlSessionEnd } from "src/lib/tauri/sqlSession";
import {
  BACKUP_FILE_ALREADY_PUBLISHED,
  BACKUP_FILE_TEMP_NOT_REMOVED,
  backupFileAbort,
  backupFileBegin,
  backupFileForget,
  backupFilePublish,
  backupFileWrite,
} from "src/lib/tauri/backupFile";
import type { DumpOperation } from "src/lib/tauri/dumpOperation";
import { tableColumnsQuery } from "src/lib/queries/sql";
import { cellToString } from "src/utils/convert";
import { packSqlToDumb } from "src/lib/dump/politedbDumbFormat";
import type { DumpOutcome } from "src/stores/dumpJob";
import type { useConnectionRuntimeCtx } from "../../workspace/ConnectionRuntimeContext";
import { backupStepsTotal } from "../dumpProgress";
import type { DumpJobHandle } from "./dumpJobController";
import {
  backupQuery,
  backupSnapshots,
  buildMysqlTableStructure,
  buildPostgresTableStructure,
  buildPostgresTypesSql,
  dumpCommentName,
  exportTableToSqlParts,
  postgresGeneratedOnlyRowsSql,
  postgresSnapshotColumns,
  postgresSnapshotTables,
  sortTablesByForeignKeys,
  type BackupTable,
} from "./backupSql";

type Runtime = ReturnType<typeof useConnectionRuntimeCtx>;

export const BACKUP_CANCELLED_MESSAGE =
  "Backup cancelled. No file was written.";

/** Stops the run where it stands (a cancel asked meanwhile). */
class Cancelled extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Backs up the connection's database into `path` as the job `job`. */
export async function runDatabaseBackup(
  rt: Pick<Runtime, "runtimeConnectionId" | "engine" | "metadata" | "metaKey">,
  path: string,
  job: DumpJobHandle
): Promise<DumpOutcome> {
  const connectionId = rt.runtimeConnectionId!;
  let snapshotSessionId: string | null = null;
  let stream: DumpOperation<unknown> | null = null;
  let fileSession: string | null = null;

  /** Throws Cancelled when a cancel was asked: start no new work. */
  const checkpoint = () => {
    if (job.stopRequested()) throw new Cancelled();
  };

  // Cancel stops the running row stream; the run stops at its next step.
  job.setCancelAction(async () => {
    const running = stream;
    if (running) {
      await running.cancel();
      await running.settled;
    }
    return { kind: "accepted", evidence: null };
  });

  // The snapshot session (read only, nothing to keep) and the backup's
  // snapshot lookup end with the run, after any stream has settled.
  const endSnapshot = async () => {
    backupSnapshots.delete(connectionId);
    if (!snapshotSessionId) return;
    const id = snapshotSessionId;
    snapshotSessionId = null;
    await job.cleanup.run(() => sqlSessionEnd(id, false).catch(() => {}));
  };

  try {
    job.setPhase("preparing", true);
    const meta = await rt.metadata.load({
      metaKey: rt.metaKey,
      engine: rt.engine,
      connectionId,
    });
    checkpoint();

    let tables: BackupTable[] = (meta.tables ?? []).filter(
      (t) => t.kind !== "view"
    );
    // PostgreSQL reads its tables through the snapshot below.
    if (!tables.length && rt.engine !== "postgres") {
      throw new Error("No tables found to backup.");
    }

    // PostgreSQL: every query of the backup reads one snapshot, so the
    // tables, their rows and sequences agree even while others write. The
    // tables and their columns are read through it too: the workspace's
    // lists may predate it.
    if (rt.engine === "postgres") {
      const session = await job.cleanup.run(() =>
        sqlSessionBegin(connectionId, "snapshot")
      );
      snapshotSessionId = session.sessionId;
      checkpoint();
      if (!session.snapshotId) {
        throw new Error("No snapshot to back up from.");
      }
      backupSnapshots.set(connectionId, { snapshotId: session.snapshotId });
      tables = await postgresSnapshotTables(connectionId);
      checkpoint();
      if (!tables.length) {
        throw new Error("No tables found to backup.");
      }
    }
    const orderedTables = await sortTablesByForeignKeys({
      connectionId,
      engine: rt.engine,
      tables,
    });
    checkpoint();

    const stepsTotal = backupStepsTotal(orderedTables.length);
    let stepsDone = 0;
    const step = (detail?: string) => {
      stepsDone++;
      job.progress({ stepsDone, stepsTotal, detail });
    };
    job.progress({ stepsDone, stepsTotal });

    const sqlParts: string[] = [];
    const appendSql = (content: string) => {
      if (content) sqlParts.push(content);
    };

    appendSql(
      [
        "-- PoliteDB database backup",
        `-- Engine: ${rt.engine}`,
        `-- Generated at: ${new Date().toISOString()}`,
        "-- Sections: structure, data",
        "",
      ].join("\n")
    );

    const postDataSqlChunks: string[] = [];
    const preDataByTable = new Map<string, string>();
    const columnsByTable = new Map<string, string[]>();
    const identityAlwaysTables = new Set<string>();
    // Tables whose columns are all generated: no column to insert.
    const generatedOnlyTables = new Set<string>();

    if (rt.engine === "mysql" || rt.engine === "mariadb") {
      appendSql("\nSET FOREIGN_KEY_CHECKS = 0;\n");
    }

    job.setPhase("structure", true);
    for (const table of orderedTables) {
      let structureSql = "";
      let postDataSql = "";
      let generatedColumns: string[] = [];
      const key = `${table.schema}.${table.name}`;

      if (rt.engine === "postgres") {
        const pgStruct = await buildPostgresTableStructure({
          connectionId,
          schema: table.schema,
          tableName: table.name,
        });
        structureSql = pgStruct.preDataSql;
        // Sequences are set after every table's rows, with the rest.
        postDataSql = pgStruct.postDataSql + pgStruct.sequenceValuesSql;
        generatedColumns = pgStruct.generatedColumns;
        if (pgStruct.identityAlways) identityAlwaysTables.add(key);
        if (pgStruct.allGenerated) generatedOnlyTables.add(key);
      } else if (rt.engine === "mysql" || rt.engine === "mariadb") {
        structureSql = await buildMysqlTableStructure({
          connectionId,
          schema: table.schema,
          tableName: table.name,
        });
      }
      checkpoint();

      if (structureSql) preDataByTable.set(key, structureSql);
      if (postDataSql) {
        postDataSqlChunks.push(
          `\n-- Post-data ${dumpCommentName(table.schema, table.name)}\n${postDataSql}`
        );
      }

      let columns =
        rt.engine === "postgres"
          ? await postgresSnapshotColumns(
              connectionId,
              table.schema,
              table.name
            )
          : (meta.columnsByTable[key] ?? []);

      if (!columns.length) {
        const colRes = await backupQuery(
          connectionId,
          tableColumnsQuery(table.schema, table.name)
        );
        columns = (colRes.rows ?? [])
          .map((r: any) => cellToString(r?.[0]) ?? "")
          .filter(Boolean);
      }
      checkpoint();

      // Generated columns are computed again on restore.
      columns = columns.filter((c) => !generatedColumns.includes(c));
      if (columns.length || generatedOnlyTables.has(key)) {
        columnsByTable.set(key, columns);
      }
      step(dumpCommentName(table.schema, table.name));
    }

    // Schemas and the types the tables use (PostgreSQL)
    if (rt.engine === "postgres") {
      const typesSql = await buildPostgresTypesSql({
        connectionId,
        tables: orderedTables,
      });
      checkpoint();
      if (typesSql) appendSql(`\n-- Schemas and types\n${typesSql}`);
    }
    step();

    // Create all tables (and non-FK constraints)
    for (const table of orderedTables) {
      const structureSql =
        preDataByTable.get(`${table.schema}.${table.name}`) ?? "";
      if (!structureSql) continue;
      appendSql(
        `\n-- Structure ${dumpCommentName(table.schema, table.name)}\n${structureSql}`
      );
    }

    // Insert data for all tables
    job.setPhase("data", true);
    let rowsBefore = 0;
    for (const table of orderedTables) {
      const key = `${table.schema}.${table.name}`;
      const label = dumpCommentName(table.schema, table.name);
      const columns = columnsByTable.get(key);
      if (!columns) {
        step(label);
        continue;
      }

      appendSql(`\n-- Data ${label}\n`);

      // Every column is generated: the rows are restored by count.
      if (!columns.length) {
        appendSql(
          await postgresGeneratedOnlyRowsSql(
            connectionId,
            table.schema,
            table.name
          )
        );
        checkpoint();
        step(label);
        continue;
      }

      let tableRows = 0;
      await exportTableToSqlParts({
        append: appendSql,
        connectionId,
        engine: rt.engine,
        schema: table.schema,
        tableName: table.name,
        columns,
        overridingSystemValue: identityAlwaysTables.has(key),
        onStream: (s) => {
          stream = s;
        },
        onRows: (rows) => {
          tableRows = rows;
          job.progress({ rows: rowsBefore + rows, detail: label });
        },
      }).catch((err) => {
        if (job.stopRequested()) throw new Cancelled();
        throw err;
      });
      stream = null;
      rowsBefore += tableRows;
      checkpoint();
      step(label);
    }

    if (postDataSqlChunks.length > 0) {
      appendSql(
        `\n-- Post-data constraints/indexes\n${postDataSqlChunks.join("\n")}`
      );
    }
    if (rt.engine === "mysql" || rt.engine === "mariadb") {
      appendSql("\nSET FOREIGN_KEY_CHECKS = 1;\n");
    }
    await endSnapshot();

    // Compression is not interrupted (D9): a cancel asked meanwhile takes
    // effect once it is done, and nothing is written.
    job.setPhase("compressing", true);
    const dumbBytes = await packSqlToDumb({
      sql: sqlParts.join(""),
      engine: rt.engine,
    });
    checkpoint();

    fileSession = await backupFileBegin(path);
    checkpoint();
    await backupFileWrite(fileSession, dumbBytes);
    checkpoint();

    // Publication is not cancellable; success only once it is done.
    job.setPhase("publishing", false);
    job.setCancelAction(null);
    const published = fileSession;
    try {
      await backupFilePublish(published);
      fileSession = null;
    } catch (err) {
      if (errorMessage(err).includes(BACKUP_FILE_ALREADY_PUBLISHED)) {
        fileSession = null;
      } else {
        return await failed(err);
      }
    }
    step();
    return { kind: "succeeded", skipped: 0 };
  } catch (err) {
    if (err instanceof Cancelled || job.stopRequested()) {
      return await cancelled();
    }
    return await failed(err);
  } finally {
    // A stream still running (a failure elsewhere) is stopped first.
    const running = stream as DumpOperation<unknown> | null;
    if (running) {
      await job.cleanup.run(async () => {
        await running.cancel();
        await running.settled;
      });
    }
    await endSnapshot();
  }

  /** Removes the temp of an unpublished backup; what became of the file. */
  async function discardFile(): Promise<
    "none" | "published" | "removed" | "not-removed" | "unconfirmed"
  > {
    const id = fileSession;
    if (!id) return "none";
    fileSession = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await job.cleanup.run(() => backupFileAbort(id));
        return "removed";
      } catch (err) {
        const message = errorMessage(err);
        if (message.includes(BACKUP_FILE_ALREADY_PUBLISHED)) {
          return "published";
        }
        if (attempt === 1) {
          if (message.includes(BACKUP_FILE_TEMP_NOT_REMOVED)) {
            await backupFileForget(id).catch(() => {});
            return "not-removed";
          }
          return "unconfirmed";
        }
      }
    }
    return "unconfirmed";
  }

  async function cancelled(): Promise<DumpOutcome> {
    const file = await discardFile();
    if (file === "published") return { kind: "succeeded", skipped: 0 };
    if (file === "not-removed") {
      return { kind: "temp-not-removed", after: "cancelled" };
    }
    if (file === "unconfirmed") return { kind: "file-unconfirmed" };
    return {
      kind: "cancelled",
      rollback: "n/a",
      message: BACKUP_CANCELLED_MESSAGE,
    };
  }

  async function failed(err: unknown): Promise<DumpOutcome> {
    const message = errorMessage(err) || "Backup database failed.";
    const file = await discardFile();
    if (file === "published") return { kind: "succeeded", skipped: 0 };
    if (file === "not-removed") {
      return { kind: "temp-not-removed", after: "failed", message };
    }
    if (file === "unconfirmed") return { kind: "file-unconfirmed" };
    return { kind: "failed", message };
  }
}
