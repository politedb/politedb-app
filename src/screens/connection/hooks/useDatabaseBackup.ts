import { useCallback, useState } from "preact/hooks";
import { useConnectionRuntimeCtx } from "../workspace/ConnectionRuntimeContext";
import { runDatabaseBackup } from "../lib/dump/backupRun";
import { runDumpImport } from "../lib/dump/restoreRun";

// The SQL and catalog helpers moved to lib/dump/backupSql.ts; re-exported
// for existing importers.
export * from "../lib/dump/backupSql";

export function useDatabaseBackup() {
  const rt = useConnectionRuntimeCtx();
  const [dbBackupRunning, setDbBackupRunning] = useState(false);
  const [dbRestoreRunning, setDbRestoreRunning] = useState(false);

  const onBackupDatabase = useCallback(
    (databaseName?: string) =>
      runDatabaseBackup(rt, databaseName, setDbBackupRunning),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt.runtimeConnectionId, rt.metadata, rt.metaKey, rt.engine]
  );

  const onRestoreDatabase = useCallback(
    async (onRefresh?: () => void, database?: string) => {
      await runDumpImport(
        rt,
        onRefresh,
        {
          action: "restore",
          dialogTitle: "Restore database from dump",
          successToast: "Database restored.",
          database,
        },
        setDbRestoreRunning
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rt.runtimeConnectionId, rt.refreshSchemaAndTables, rt.profileId, rt.engine]
  );

  // Table-level SQL dump import, like database backup and restore, is free.
  const onImportSqlDump = useCallback(
    async (onRefresh?: () => void, opts?: { tabId?: string }) => {
      await runDumpImport(
        rt,
        onRefresh,
        {
          action: "import",
          dialogTitle: "Import SQL dump",
          successToast: "SQL dump imported.",
          tabId: opts?.tabId,
        },
        setDbRestoreRunning
      );
    },
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
