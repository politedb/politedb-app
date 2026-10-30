import { useCallback } from "preact/hooks";
import { openDialog, saveDialog, showMessage } from "src/lib/system-dialog";
import { showToast } from "src/stores/toast";
import { useScreenStore } from "src/stores/screen";
import { dumpRunGate, tabSafetyModeNow } from "src/lib/dump/dumpRestoreSafety";
import {
  useDumpJobStore,
  type DumpJobKind,
  type DumpOutcome,
} from "src/stores/dumpJob";
import { useConnectionRuntimeCtx } from "../workspace/ConnectionRuntimeContext";
import { canBackupDatabase } from "../lib/dump/backupSql";
import { runDatabaseBackup } from "../lib/dump/backupRun";
import { runDumpImport, type DumpImportOptions } from "../lib/dump/restoreRun";
import { startDumpJob } from "../lib/dump/dumpJobController";
import { dumpJobTitle, quietCancelToast } from "../lib/dump/dumpOutcomeText";

// The SQL and catalog helpers moved to lib/dump/backupSql.ts; re-exported
// for existing importers.
export * from "../lib/dump/backupSql";

/**
 * Shows a finished job's outcome when nothing needs reading: a toast. An
 * outcome to read stays as the job's retained result, which the progress
 * modal shows until Close (D15).
 */
function present(
  kind: DumpJobKind,
  outcome: DumpOutcome,
  successToast: string
) {
  if (outcome.kind === "succeeded" && !outcome.warning) {
    if (outcome.skipped > 0) {
      showToast(
        `${successToast} ${outcome.skipped} statement${outcome.skipped === 1 ? " was" : "s were"} skipped: objects that already existed or foreign keys the data did not allow.`,
        { tone: "info" }
      );
    } else {
      showToast(successToast, { tone: "success" });
    }
    return;
  }
  // A cancel with nothing more to read closes quietly (D12).
  const cancelled = quietCancelToast(kind, outcome);
  if (cancelled) showToast(cancelled, { tone: "info" });
}

function tabTarget(tabId: string, database?: string): string {
  const tab = useScreenStore
    .getState()
    .profileTabs.find((item) => item.id === tabId);
  return [tab?.label, database ? `(${database})` : ""]
    .filter(Boolean)
    .join(" ");
}

export function useDatabaseBackup() {
  const rt = useConnectionRuntimeCtx();
  // The one job of the app (D11), wherever it was started from.
  const activeKind = useDumpJobStore((st) => st.active?.kind ?? null);
  const dbBackupRunning = activeKind === "backup";
  const dbRestoreRunning = activeKind === "restore" || activeKind === "import";

  /** Registers a job before its file dialog (D11, D14). */
  const start = (kind: DumpJobKind, tabId: string, database?: string) => {
    const started = startDumpJob(kind, {
      tabId,
      runtimeConnectionId: rt.runtimeConnectionId!,
      engine: rt.engine,
      target: tabTarget(tabId, database),
    });
    if (!started.ok) {
      void showMessage(started.message, {
        title: dumpJobTitle(kind, false),
        kind: "info",
      });
      return null;
    }
    return started.job;
  };

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
      const job = start("backup", rt.profileId, databaseName);
      if (!job) return;
      let outcome: DumpOutcome = { kind: "abandoned" };
      try {
        const stamp = new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, "");
        const path = await saveDialog({
          title: "Backup database",
          defaultPath: `${databaseName || "database"}-backup-${stamp}.dumb`,
          filters: [{ name: "PoliteDB dump", extensions: ["dumb"] }],
        });
        if (path && job.isCurrent()) {
          outcome = await runDatabaseBackup(rt, path, job);
        }
      } catch (err) {
        outcome = {
          kind: "failed",
          message:
            err instanceof Error ? err.message : "Backup database failed.",
        };
      } finally {
        await job.finish(outcome);
      }
      present("backup", outcome, "Database backup completed.");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt.runtimeConnectionId, rt.metadata, rt.metaKey, rt.engine, rt.profileId]
  );

  const runImport = async (
    onRefresh: (() => void) | undefined,
    opts: DumpImportOptions
  ) => {
    if (!rt.runtimeConnectionId) return;
    const tabId = opts.tabId ?? rt.profileId;
    const kind = opts.action === "restore" ? "restore" : "import";
    // Lock and Production refuse before a file is even chosen.
    const early = dumpRunGate(tabSafetyModeNow(tabId), opts.action);
    if (early.kind === "blocked") {
      void showMessage(early.message, {
        title: dumpJobTitle(kind, true),
        kind: "warning",
      });
      return;
    }
    const job = start(kind, tabId, opts.database);
    if (!job) return;
    let outcome: DumpOutcome = { kind: "abandoned" };
    try {
      const path = await openDialog({
        title: opts.dialogTitle,
        multiple: false,
        directory: false,
        filters: [
          { name: "PoliteDB dump", extensions: ["dumb"] },
          { name: "SQL", extensions: ["sql"] },
        ],
      });
      if (path && typeof path === "string" && job.isCurrent()) {
        outcome = await runDumpImport(
          rt,
          path,
          { ...opts, tabId },
          job,
          onRefresh
        );
      }
    } catch (err) {
      outcome = {
        kind: "failed",
        message: err instanceof Error ? err.message : "SQL dump import failed.",
      };
    } finally {
      await job.finish(outcome);
    }
    present(kind, outcome, opts.successToast);
  };

  const onRestoreDatabase = useCallback(
    (onRefresh?: () => void, database?: string) =>
      runImport(onRefresh, {
        action: "restore",
        dialogTitle: "Restore database from dump",
        successToast: "Database restored.",
        database,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt.runtimeConnectionId, rt.refreshSchemaAndTables, rt.profileId, rt.engine]
  );

  // Table-level SQL dump import, like database backup and restore, is free.
  const onImportSqlDump = useCallback(
    (onRefresh?: () => void, opts?: { tabId?: string }) =>
      runImport(onRefresh, {
        action: "import",
        dialogTitle: "Import SQL dump",
        successToast: "SQL dump imported.",
        tabId: opts?.tabId,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt.runtimeConnectionId, rt.refreshSchemaAndTables, rt.profileId, rt.engine]
  );

  return {
    dbBackupRunning,
    dbRestoreRunning,
    onBackupDatabase,
    onRestoreDatabase,
    onImportSqlDump,
  };
}
