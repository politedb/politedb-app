import { confirmDialog } from "src/lib/system-dialog";
import { readFile } from "src/lib/system-fs";
import { dumpStatement } from "src/lib/tauri/dumpOperation";
import {
  sqlSessionBegin,
  sqlSessionCancel,
  sqlSessionEnd,
  sqlSessionExecute,
} from "src/lib/tauri/sqlSession";
import {
  splitDialectFor,
  splitSqlStatements,
} from "src/components/editor/splitSqlStatements";
import { useScreenStore } from "src/stores/screen";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import { dumpRunGate, tabSafetyModeNow } from "src/lib/dump/dumpRestoreSafety";
import { unpackDumpBytes } from "src/lib/dump/politedbDumbFormat";
import type {
  DumpCounts,
  DumpOutcome,
  RollbackEvidence,
} from "src/stores/dumpJob";
import type { useConnectionRuntimeCtx } from "../../workspace/ConnectionRuntimeContext";
import type { CancelActionResult, DumpJobHandle } from "./dumpJobController";
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
type RunRuntime = Pick<
  Runtime,
  "runtimeConnectionId" | "engine" | "refreshSchemaAndTables"
>;

export type DumpImportOptions = {
  action: "restore" | "import";
  dialogTitle: string;
  successToast: string;
  /** The tab whose safety mode applies; the active one by default. */
  tabId?: string;
  /** The database the dump goes into, named in the confirmation. */
  database?: string;
};

/** The limit of one statement run outside a transaction. */
const STATEMENT_TIMEOUT_MS = 120_000;

/** Added whenever a PostgreSQL statement was sent (D7). */
export const SEQUENCE_NOTE =
  "Sequence changes (nextval, setval) and effects outside the database (for example dblink or extensions) are not undone.";

/** What is known about a transaction that was not committed (D7). */
export function rollbackText(
  evidence: RollbackEvidence,
  statementsSent: boolean
): string {
  const base =
    evidence === "rolled-back"
      ? "The transaction was rolled back."
      : evidence === "not-committed-closed"
        ? "The transaction was not committed. The server rolls it back when its connection closes."
        : evidence === "cleanup-unconfirmed"
          ? "The transaction was not committed by PoliteDB, but closing its connection could not be confirmed. Close the connection or check the server before restoring again."
          : "Nothing was run.";
  return statementsSent && evidence !== "nothing-run"
    ? `${base} ${SEQUENCE_NOTE}`
    : base;
}

/** The COMMIT got no answer (sql_session.rs COMMIT_OUTCOME_UNKNOWN). */
function isCommitUnknown(message: string): boolean {
  return message.startsWith("The connection closed while committing");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A cancel of the session, by what it established (D7 evidence). */
async function cancelSession(sessionId: string): Promise<CancelActionResult> {
  try {
    const outcome = await sqlSessionCancel(sessionId);
    if (outcome === "cancelled" || outcome === "already_closed_by_cancel") {
      return { kind: "accepted", evidence: "not-committed-closed" };
    }
    return { kind: "failed", error: `SQL_SESSION_${outcome.toUpperCase()}` };
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("SQL_SESSION_COMMITTING")) {
      return {
        kind: "refused",
        reason: "Committing: this can no longer be cancelled.",
      };
    }
    return { kind: "failed", error: message };
  }
}

type Prepared = {
  statements: string[];
  transactional: boolean;
  nonEmpty: string[];
};

/**
 * Reads, splits and checks a dump; throws with the message to show.
 */
async function prepare(
  rt: RunRuntime,
  connectionId: string,
  path: string,
  action: DumpImportOptions["action"],
  job: DumpJobHandle
): Promise<Prepared> {
  job.setPhase("reading", false);
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

  // Split by the engine's own quoting rules: read the PostgreSQL way, a
  // backslash in a string is text, and data can never end a string early
  // and turn the rest into statements.
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
    // The run owns its transaction: a statement that commits, rolls back
    // or opens another would end it partway.
    const control = statements.findIndex(isTransactionControl);
    if (control >= 0) {
      throw new Error(
        `Statement ${control + 1} of ${statements.length} controls transactions (${restoreStatementLabel(statements[control]!)}). The ${action} runs in one transaction of its own, so nothing was run: remove such statements from the file.`
      );
    }
  }
  job.setPhase("checking", false);
  const nonEmpty = transactional
    ? await pgTablesWithRows(connectionId, statements)
    : [];
  return { statements, transactional, nonEmpty };
}

/**
 * Runs a SQL dump the user picked on the connection (a database restore or
 * a table-level import) as the job `job`, and returns its outcome. The
 * caller shows it.
 *
 * PostgreSQL runs in one transaction on a session of its own (cancel
 * closes it; nothing is committed). Other engines run statement by
 * statement: a cancel stops at the next statement boundary, after asking.
 */
export async function runDumpImport(
  rt: RunRuntime,
  path: string,
  opts: DumpImportOptions & { tabId: string },
  job: DumpJobHandle,
  onRefresh: (() => void) | undefined
): Promise<DumpOutcome> {
  const connectionId = rt.runtimeConnectionId!;
  const { action, tabId } = opts;

  let prepared: Prepared;
  try {
    prepared = await prepare(rt, connectionId, path, action, job);
  } catch (err) {
    return { kind: "failed", message: errorMessage(err) };
  }
  if (!job.isCurrent()) return { kind: "abandoned" };
  const { statements, transactional, nonEmpty } = prepared;
  const total = statements.length;

  // Confirmation (D7 wording for PostgreSQL).
  job.setPhase("confirming", false);
  const tab = useScreenStore
    .getState()
    .profileTabs.find((item) => item.id === tabId);
  const target = [tab?.label, opts.database ? `(${opts.database})` : ""]
    .filter(Boolean)
    .join(" ");
  const fileName = path.split(/[\\/]/).pop() || path;
  const verb = action === "restore" ? "Restore" : "Import";
  const runs = `This runs ${total} SQL statement${total === 1 ? "" : "s"} on the database.`;
  const atomicity = transactional
    ? "They run in one transaction: if one fails or the run is cancelled, it is not committed. Sequence changes and effects outside the database are not undone. Once committed, it cannot be undone."
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
  if (!ok || !job.isCurrent()) return { kind: "abandoned" };

  const counts: DumpCounts = { completed: 0, skipped: 0, unknown: 0, total };
  const snapshot = (): DumpCounts => ({ ...counts });

  // Checked before the run and before every statement, on the originating
  // tab's live mode: it may change during the confirmation, Touch ID or
  // the run itself. Touch ID is asked once, when first needed.
  let authenticated = false;
  const ensureAllowed = async (): Promise<string | null> => {
    for (;;) {
      const gate = dumpRunGate(
        tabSafetyModeNow(tabId),
        action,
        // A transactional run is not committed: nothing stays.
        counts.completed > 0 && !transactional
      );
      if (gate.kind === "blocked") return gate.message;
      if (gate.kind === "run" || authenticated) return null;
      job.setPhase("authenticating", false);
      try {
        await securityTouchIdAuthenticate(gate.prompt);
        authenticated = true;
      } catch (err) {
        return `Touch ID authentication failed, so ${counts.completed > 0 && !transactional ? "nothing more" : "nothing"} was run: ${errorMessage(err)}`;
      }
    }
  };

  const refused = await ensureAllowed();
  if (refused) {
    return {
      kind: "stopped",
      reason: "safety",
      message: refused,
      rollback: transactional ? "nothing-run" : undefined,
      counts: snapshot(),
    };
  }
  if (!job.isCurrent()) return { kind: "abandoned" };

  const refresh = async () => {
    await rt.refreshSchemaAndTables();
    onRefresh?.();
  };
  const strategy = transactional ? runInTransaction : runStatementByStatement;
  return strategy({
    connectionId,
    statements,
    counts,
    snapshot,
    ensureAllowed,
    job,
    action,
    refresh,
    successToast: opts.successToast,
  });
}

type RunArgs = {
  connectionId: string;
  statements: string[];
  counts: DumpCounts;
  snapshot: () => DumpCounts;
  ensureAllowed: () => Promise<string | null>;
  job: DumpJobHandle;
  action: DumpImportOptions["action"];
  refresh: () => Promise<void>;
  successToast: string;
};

/** Updates the job's progress after a statement. */
function report(job: DumpJobHandle, counts: DumpCounts, sql?: string) {
  job.progress({
    stepsTotal: counts.total,
    stepsDone: counts.completed + counts.skipped + counts.unknown,
    counts: { ...counts },
    detail: sql === undefined ? undefined : restoreStatementLabel(sql, 80),
  });
}

/**
 * PostgreSQL: one transaction on a session of its own, a savepoint per
 * statement so one that may be skipped is undone alone. Nothing is
 * committed unless every statement ran and the mode still allows it.
 */
async function runInTransaction(a: RunArgs): Promise<DumpOutcome> {
  const { job, counts, statements } = a;
  const total = statements.length;
  job.setPhase("running", true);
  report(job, counts);

  // Cancel during begin cancels the session once it exists (a late id).
  const begin = sqlSessionBegin(a.connectionId, "transaction");
  begin.catch(() => {});
  job.setCancelAction(async () => {
    const opened = await begin.catch(() => null);
    if (!opened) return { kind: "accepted", evidence: "nothing-run" };
    return cancelSession(opened.sessionId);
  });

  let session: string;
  try {
    session = (await begin).sessionId;
  } catch (err) {
    await job.cleanup.settled();
    if (job.stopRequested()) {
      return cancelledOutcome(a, "nothing-run", false);
    }
    return {
      kind: "failed",
      message: errorMessage(err),
      rollback: "nothing-run",
      counts: a.snapshot(),
    };
  }
  let sent = false;

  /**
   * Ends the run without committing: the cancel's evidence if it gave
   * one, otherwise ROLLBACK (then a cancel) as fallback.
   */
  const abandon = async (): Promise<RollbackEvidence> => {
    await job.cleanup.settled();
    if (job.cleanup.evidence) return job.cleanup.evidence;
    const rollback = await job.cleanup.run(() =>
      sqlSessionEnd(session, false).then(
        () => "rolled-back" as const,
        () => null
      )
    );
    job.cleanup.record(rollback);
    if (job.cleanup.evidence) return job.cleanup.evidence;
    // The user cancelled: offer retries (they never overlap).
    while (job.stopRequested()) {
      const choice = await job.offerRetry(
        "The transaction could not be closed."
      );
      if (choice === "stop") break;
      const retry = await job.cleanup.run(() => cancelSession(session));
      if (retry.kind === "accepted") job.cleanup.record(retry.evidence);
      if (job.cleanup.evidence) return job.cleanup.evidence;
    }
    if (!job.stopRequested()) {
      // A failure or safety stop: one cancel attempt, no prompt.
      const retry = await job.cleanup.run(() => cancelSession(session));
      if (retry.kind === "accepted") job.cleanup.record(retry.evidence);
    }
    return job.cleanup.evidence ?? "cleanup-unconfirmed";
  };

  for (let i = 0; i < total; i++) {
    const statementSql = statements[i]!;
    if (job.stopRequested()) {
      return cancelledOutcome(a, await abandon(), sent);
    }
    try {
      const parsed = parsePgAlterAddConstraint(statementSql);
      if (parsed) {
        const exists = await pgConstraintExists({
          connectionId: a.connectionId,
          schema: parsed.schema,
          table: parsed.table,
          constraint: parsed.constraint,
        });
        if (exists) {
          counts.skipped++;
          report(job, counts, statementSql);
          continue;
        }
      }
      const blocked = await a.ensureAllowed();
      job.setPhase("running", true);
      if (job.stopRequested()) {
        return cancelledOutcome(a, await abandon(), sent);
      }
      if (blocked) {
        const evidence = await abandon();
        return {
          kind: "stopped",
          reason: "safety",
          message: `${blocked}\nStopped before statement ${i + 1} of ${total}. ${rollbackText(evidence, sent)}`,
          rollback: evidence,
          counts: a.snapshot(),
        };
      }
      report(job, counts, statementSql);
      await sqlSessionExecute(session, "SAVEPOINT politedb_restore");
      sent = true;
      await sqlSessionExecute(session, statementSql);
      await sqlSessionExecute(session, "RELEASE SAVEPOINT politedb_restore");
      counts.completed++;
      report(job, counts, statementSql);
    } catch (err) {
      // A cancel closed the session: that is the outcome, not this error.
      if (job.stopRequested()) {
        return cancelledOutcome(a, await abandon(), sent);
      }
      if (
        isPgAddForeignKeyStatement(statementSql) ||
        isIgnorableRestoreError(statementSql, err)
      ) {
        // Keep the restore going: an object that already exists, or a
        // foreign key the data does not allow. Undone at its savepoint.
        try {
          await sqlSessionExecute(
            session,
            "ROLLBACK TO SAVEPOINT politedb_restore"
          );
          await sqlSessionExecute(
            session,
            "RELEASE SAVEPOINT politedb_restore"
          );
        } catch (undoErr) {
          if (job.stopRequested()) {
            return cancelledOutcome(a, await abandon(), sent);
          }
          const evidence = await abandon();
          return {
            kind: "failed",
            message: `Stopped at statement ${i + 1} of ${total}: ${restoreErrorSummary(undoErr)}\n\n${rollbackText(evidence, sent)}\n\nStatement: ${restoreStatementLabel(statementSql)}`,
            rollback: evidence,
            counts: a.snapshot(),
          };
        }
        counts.skipped++;
        report(job, counts, statementSql);
        continue;
      }
      const evidence = await abandon();
      return {
        kind: "failed",
        message: `Stopped at statement ${i + 1} of ${total}: ${restoreErrorSummary(err)}\n\n${rollbackText(evidence, sent)}\n\nStatement: ${restoreStatementLabel(statementSql)}`,
        rollback: evidence,
        counts: a.snapshot(),
      };
    }
  }

  // The last statement may have run while the tab was locked, switched
  // to Production or closed: nothing is kept then.
  const refusedAtEnd = await a.ensureAllowed();
  if (job.stopRequested()) {
    return cancelledOutcome(a, await abandon(), sent);
  }
  if (refusedAtEnd) {
    const evidence = await abandon();
    return {
      kind: "stopped",
      reason: "safety",
      message: `${refusedAtEnd}\nStopped before committing. ${rollbackText(evidence, sent)}`,
      rollback: evidence,
      counts: a.snapshot(),
    };
  }

  // From here Cancel is refused (synchronously, before COMMIT is sent).
  job.setPhase("committing", false);
  job.setCancelAction(null);
  try {
    await sqlSessionEnd(session, true);
  } catch (err) {
    const message = errorMessage(err);
    await job.cleanup.settled();
    // A cancel that won the session before COMMIT: nothing was sent.
    if (message.includes("SQL_SESSION_ENDED") && job.cleanup.evidence) {
      return cancelledOutcome(a, job.cleanup.evidence, sent);
    }
    job.setPhase("refreshing", false);
    await a.refresh().catch(() => {});
    if (isCommitUnknown(message)) {
      return {
        kind: "commit-unknown",
        message: `The ${a.action} could not be committed: ${message}`,
      };
    }
    // The server answered: the transaction is over, not committed.
    return {
      kind: "failed",
      message: `The ${a.action} could not be committed: ${message}`,
      rollback: "rolled-back",
      counts: a.snapshot(),
    };
  }
  return committed(a);
}

/** After a COMMIT (or the last statement elsewhere): refresh, then done. */
async function committed(a: RunArgs): Promise<DumpOutcome> {
  a.job.setPhase("refreshing", false);
  try {
    await a.refresh();
  } catch (err) {
    return {
      kind: "committed-refresh-failed",
      message: `The ${a.action} was committed, but the schema could not be refreshed: ${errorMessage(err)}`,
    };
  }
  return { kind: "succeeded", skipped: a.counts.skipped };
}

function cancelledOutcome(
  a: RunArgs,
  evidence: RollbackEvidence,
  sent: boolean
): DumpOutcome {
  return {
    kind: "cancelled",
    rollback: evidence,
    counts: a.snapshot(),
    message: `Cancelled. ${rollbackText(evidence, sent)}`,
  };
}

/** What already ran, outside a transaction. */
function describeApplied(counts: DumpCounts): string {
  const ran = counts.completed;
  const text =
    ran === 0
      ? "Nothing before it had changed the database."
      : ran === 1
        ? "The statement before it already ran and stays in the database."
        : `The ${ran} statements before it already ran and stay in the database.`;
  return counts.unknown > 0
    ? `${text} The last statement may still be running on the server or be partly applied.`
    : text;
}

/**
 * Other engines: statement by statement, no transaction. A cancel never
 * interrupts a running statement (D3): once it has settled, the user is
 * asked whether to stop (D10).
 */
async function runStatementByStatement(a: RunArgs): Promise<DumpOutcome> {
  const { job, counts, statements } = a;
  const total = statements.length;
  job.setPhase("running", true);
  job.setCancelAction(null);
  report(job, counts);

  const changed = () => counts.completed + counts.unknown > 0;
  const stopWithRefresh = async (outcome: DumpOutcome) => {
    if (changed()) {
      job.setPhase("refreshing", false);
      await a.refresh().catch(() => {});
    }
    return outcome;
  };
  /** Asked once a statement settled; true when the user chose Stop. */
  const userStops = async (): Promise<boolean> => {
    if (!job.stopRequested()) return false;
    return job.askStop(a.snapshot());
  };
  const stoppedByUser = (beforeIndex: number) =>
    stopWithRefresh({
      kind: "stopped",
      reason: "user",
      message:
        beforeIndex >= total
          ? `Stopped after the last statement: all ${total} ran.`
          : `Stopped before statement ${beforeIndex + 1} of ${total}. ${describeApplied(counts)}`,
      counts: a.snapshot(),
    });

  for (let i = 0; i < total; i++) {
    const statementSql = statements[i]!;
    if (await userStops()) return stoppedByUser(i);
    const blocked = await a.ensureAllowed();
    job.setPhase("running", true);
    if (blocked) {
      return stopWithRefresh({
        kind: "stopped",
        reason: "safety",
        message: `${blocked}\nStopped before statement ${i + 1} of ${total}. ${describeApplied(counts)}`,
        counts: a.snapshot(),
      });
    }
    if (await userStops()) return stoppedByUser(i);

    report(job, counts, statementSql);
    const op = dumpStatement(a.connectionId, statementSql, {
      timeoutMs: STATEMENT_TIMEOUT_MS,
    });
    const settled = await op.settled;
    if (settled.kind === "client-disposed") {
      // Timed out (or lost): the server may still run it.
      counts.unknown++;
      report(job, counts, statementSql);
      return stopWithRefresh({
        kind: "failed",
        message: `Stopped at statement ${i + 1} of ${total}: ${restoreErrorSummary(settled.error)}\n\n${describeApplied(counts)}\n\nStatement: ${restoreStatementLabel(statementSql)}`,
        counts: a.snapshot(),
      });
    }
    if (settled.error !== undefined) {
      if (isIgnorableRestoreError(statementSql, settled.error)) {
        counts.skipped++;
        report(job, counts, statementSql);
        continue;
      }
      return stopWithRefresh({
        kind: "failed",
        message: `Stopped at statement ${i + 1} of ${total}: ${restoreErrorSummary(settled.error)}\n\n${describeApplied(counts)}\n\nStatement: ${restoreStatementLabel(statementSql)}`,
        counts: a.snapshot(),
      });
    }
    counts.completed++;
    report(job, counts, statementSql);
  }

  // A cancel asked during the last statement: it all ran.
  if (job.stopRequested()) return stoppedByUser(total);
  return committed(a);
}
