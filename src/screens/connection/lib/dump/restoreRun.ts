import { confirmDialog, openDialog, showMessage } from "src/lib/system-dialog";
import { readFile } from "src/lib/system-fs";
import { runSqlQuery } from "src/lib/tauri/query";
import {
  sqlSessionBegin,
  sqlSessionEnd,
  sqlSessionExecute,
} from "src/lib/tauri/sqlSession";
import {
  splitDialectFor,
  splitSqlStatements,
} from "src/components/editor/splitSqlStatements";
import { showToast } from "src/stores/toast";
import { useScreenStore } from "src/stores/screen";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import { dumpRunGate, tabSafetyModeNow } from "src/lib/dump/dumpRestoreSafety";
import { unpackDumpBytes } from "src/lib/dump/politedbDumbFormat";
import type { useConnectionRuntimeCtx } from "../../workspace/ConnectionRuntimeContext";
import {
  isIgnorableRestoreError,
  isPgAddForeignKeyStatement,
  isTransactionControl,
  normalizeEngineNameForCompare,
  parseBackupEngine,
  parsePgAlterAddConstraint,
  pgConstraintExists,
  pgTablesWithRows,
  restoreErrorSummary,
  restoreStatementLabel,
} from "./backupSql";

type Runtime = ReturnType<typeof useConnectionRuntimeCtx>;

export type DumpImportOptions = {
  action: "restore" | "import";
  dialogTitle: string;
  successToast: string;
  /** The tab whose safety mode applies; the active one by default. */
  tabId?: string;
  /** The database the dump goes into, named in the confirmation. */
  database?: string;
};

/**
 * Runs a SQL dump the user picks on the connection: a database restore or
 * a table-level import.
 */
export async function runDumpImport(
  rt: Pick<
    Runtime,
    "runtimeConnectionId" | "engine" | "profileId" | "refreshSchemaAndTables"
  >,
  onRefresh: (() => void) | undefined,
  opts: DumpImportOptions,
  setRunning: (running: boolean) => void
): Promise<void> {
  if (!rt.runtimeConnectionId) return;
  const { action } = opts;
  const tabId = opts.tabId ?? rt.profileId;
  const errorTitle = action === "restore" ? "Restore error" : "Import error";

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

  setRunning(true);

  let applied = 0;
  /** The transaction a PostgreSQL run is in, until committed. */
  let session: string | null = null;
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

    // PostgreSQL restores run in one transaction: all or nothing.
    const transactional = rt.engine === "postgres";
    if (transactional) {
      // The run owns its transaction: a statement that commits, rolls
      // back or opens another would end it partway.
      const control = statements.findIndex(isTransactionControl);
      if (control >= 0) {
        throw new Error(
          `Statement ${control + 1} of ${statements.length} controls transactions (${restoreStatementLabel(statements[control]!)}). The ${action} runs in one transaction of its own, so nothing was run: remove such statements from the file.`
        );
      }
    }
    const nonEmpty = transactional
      ? await pgTablesWithRows(rt.runtimeConnectionId, statements)
      : [];

    const tab = useScreenStore
      .getState()
      .profileTabs.find((item) => item.id === tabId);
    const target = [tab?.label, opts.database ? `(${opts.database})` : ""]
      .filter(Boolean)
      .join(" ");
    const fileName = path.split(/[\\/]/).pop() || path;
    const verb = action === "restore" ? "Restore" : "Import";
    const runs = `This runs ${statements.length} SQL statement${statements.length === 1 ? "" : "s"} on the database.`;
    const atomicity = transactional
      ? "They run in one transaction: if one fails or the run is stopped, nothing is changed. Once finished, it cannot be undone."
      : "They do not run in a transaction and cannot be undone.";
    const overlay = nonEmpty.length
      ? `\n\nThese tables already have rows: ${nonEmpty.slice(0, 5).join(", ")}${nonEmpty.length > 5 ? ` and ${nonEmpty.length - 5} more` : ""}. The backup's rows are added to them (a row whose key exists stops the run) and their sequences are set to the backup's. Restore into an empty database for an exact copy.`
      : "";
    const ok = await confirmDialog(
      `${verb} "${fileName}"${target ? ` into ${target}` : ""}?\n\n${runs} ${atomicity}${overlay}`,
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
          // A transactional run is rolled back: nothing stays.
          applied > 0 && !transactional
        );
        if (gate.kind === "blocked") return gate.message;
        if (gate.kind === "run" || authenticated) return null;
        try {
          await securityTouchIdAuthenticate(gate.prompt);
          authenticated = true;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return `Touch ID authentication failed, so ${applied > 0 && !transactional ? "nothing more" : "nothing"} was run: ${reason}`;
        }
      }
    };
    const describeApplied = () =>
      transactional
        ? "Nothing was changed: the run was rolled back."
        : applied === 0
          ? "Nothing before it had changed the database."
          : applied === 1
            ? "The statement before it already ran and stays in the database."
            : `The ${applied} statements before it already ran and stay in the database.`;

    const refused = await ensureAllowed();
    if (refused) {
      void showMessage(refused, { title: errorTitle, kind: "warning" });
      return;
    }

    // Statements run in the session's transaction, each behind a
    // savepoint so one that may be skipped (an object that already
    // exists) is undone alone.
    if (transactional) {
      session = (await sqlSessionBegin(rt.runtimeConnectionId, "transaction"))
        .sessionId;
    }
    const execute = async (sql: string) => {
      if (!session) {
        await runSqlQuery(rt.runtimeConnectionId!, sql, {
          timeoutMs: 120_000,
        });
        return;
      }
      await sqlSessionExecute(session, "SAVEPOINT politedb_restore");
      await sqlSessionExecute(session, sql);
      await sqlSessionExecute(session, "RELEASE SAVEPOINT politedb_restore");
    };
    const undoStatement = async () => {
      if (!session) return;
      await sqlSessionExecute(
        session,
        "ROLLBACK TO SAVEPOINT politedb_restore"
      );
      await sqlSessionExecute(session, "RELEASE SAVEPOINT politedb_restore");
    };

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

        await execute(statementSql);
        applied++;
      } catch (err) {
        if (
          rt.engine === "postgres" &&
          isPgAddForeignKeyStatement(statementSql)
        ) {
          // Keep restore progressing even if existing data violates FK
          // or FK already exists with incompatible shape.
          await undoStatement();
          skipped++;
          continue;
        }

        if (isIgnorableRestoreError(statementSql, err)) {
          await undoStatement();
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
      if (session) {
        const s = session;
        session = null;
        await sqlSessionEnd(s, false);
      }
      // What already ran is in the database: show it.
      if (applied > 0 && !transactional) {
        await rt.refreshSchemaAndTables();
        onRefresh?.();
      }
      void showMessage(
        `${stopped.message}\nStopped before statement ${stopped.index + 1} of ${statements.length}. ${describeApplied()}`,
        { title: errorTitle, kind: "warning" }
      );
      return;
    }

    if (session) {
      // The last statement may have run while the tab was locked,
      // switched to Production or closed: nothing is kept then.
      const refusedAtEnd = await ensureAllowed();
      const s = session;
      session = null;
      if (refusedAtEnd) {
        await sqlSessionEnd(s, false);
        void showMessage(
          `${refusedAtEnd}\nStopped before committing. ${describeApplied()}`,
          { title: errorTitle, kind: "warning" }
        );
        return;
      }
      try {
        await sqlSessionEnd(s, true);
      } catch (err) {
        // A COMMIT with no answer may have been applied: show what
        // the database now holds.
        await rt.refreshSchemaAndTables();
        onRefresh?.();
        throw new Error(
          `The ${action} could not be committed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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
    // Anything not committed is rolled back.
    if (session) void sqlSessionEnd(session, false).catch(() => {});
    setRunning(false);
  }
}
