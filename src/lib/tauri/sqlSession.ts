import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

/**
 * A PostgreSQL session held on one connection across calls:
 * - "transaction": statements run in one transaction, committed or rolled
 *   back at the end (a restore that is all or nothing);
 * - "snapshot": a read-only transaction whose exported snapshot other
 *   queries can read (runSqlQuery/startSqlQueryStream snapshotId), so a
 *   backup sees one database state.
 */
export async function sqlSessionBegin(
  connectionId: string,
  mode: "transaction" | "snapshot"
): Promise<{ sessionId: string; snapshotId: string | null }> {
  const res = await invoke<{
    session_id: string;
    snapshot_id: string | null;
  }>(CMD.sqlSessionBegin, {
    input: { connection_id: connectionId, mode },
  });
  return { sessionId: res.session_id, snapshotId: res.snapshot_id };
}

/** Runs SQL in the session's transaction. */
export async function sqlSessionExecute(
  sessionId: string,
  sql: string
): Promise<void> {
  await invoke(CMD.sqlSessionExecute, { sessionId, sql });
}

/** Commits or rolls back, and ends the session. */
export async function sqlSessionEnd(
  sessionId: string,
  commit: boolean
): Promise<void> {
  await invoke(CMD.sqlSessionEnd, { sessionId, commit });
}

/**
 * What a cancel established: this side closed the session's connection
 * and end() sent no COMMIT ("cancelled", "already_closed_by_cancel"), or
 * nothing ("already_ended": closed by end or a forced close; "unknown": no
 * such session). Never a server-confirmed rollback.
 */
export type SqlSessionCancelOutcome =
  | "cancelled"
  | "already_closed_by_cancel"
  | "already_ended"
  | "unknown";

/**
 * Cancels a session at once (a running statement too), unless its COMMIT
 * or ROLLBACK was already sent: then it rejects with
 * SQL_SESSION_COMMITTING and changes nothing.
 */
export async function sqlSessionCancel(
  sessionId: string
): Promise<SqlSessionCancelOutcome> {
  return invoke<SqlSessionCancelOutcome>(CMD.sqlSessionCancel, { sessionId });
}
