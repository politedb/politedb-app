import type { AnalyzeRefusal } from "src/lib/sql/analyzeClassify";

/** Fixed sentences only: no server text is ever shown (plan D6). */
const REFUSALS: Record<AnalyzeRefusal | "unsupported_engine", string> = {
  empty: "There is no statement to measure.",
  unterminated:
    "The statement could not be read: a quote, dollar quote or comment is not closed.",
  multiple_statements:
    "Explain Analyze measures one statement at a time. Put the cursor in a single statement or select just one.",
  not_read_only_shape:
    "Explain Analyze supports read-only queries (SELECT, WITH, VALUES, TABLE). To measure other statements, run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) yourself with Run.",
  parameters:
    "Statements with parameters ($1, $2, ...) can't be measured. Replace them with sample values first.",
  data_changing:
    "Explain Analyze does not run statements that may change data. If a column or table is named like a SQL keyword (for example start or comment), wrap it in double quotes.",
  row_lock:
    "Explain Analyze does not run statements that lock rows (FOR UPDATE / FOR SHARE).",
  unsupported_engine: "Explain Analyze is available for PostgreSQL only.",
};

const ERRORS: Record<string, string> = {
  read_only_violation:
    "The statement tried to write data (for example through a function or a sequence). Explain Analyze runs read-only, so it was stopped.",
  timeout: "The statement ran longer than 60 seconds and was stopped.",
  lock_timeout:
    "The statement waited more than 5 seconds for a lock held by another session and was stopped.",
  permission_denied:
    "PostgreSQL refused the statement: the current role lacks a privilege.",
  object_missing:
    "A table, column or function in the statement does not exist (in a fresh session without the editor's temporary tables or settings).",
  syntax_error: "PostgreSQL reported a syntax error in the statement.",
  connect_failed: "Could not open a connection for the measurement.",
  setup_failed: "Could not prepare the measurement.",
  rollback_failed:
    "The measurement finished but could not be rolled back cleanly, so no plan is shown. The connection was closed.",
  cancelled: "Cancelled.",
  no_response:
    "No response from the server. The measurement was abandoned; the connection is closed when the server lets go.",
  busy: "Another Explain Analyze is still running on this connection.",
  failed: "The measurement failed.",
};

export function explainAnalyzeRefusalMessage(reason: string): string {
  return (
    REFUSALS[reason as keyof typeof REFUSALS] ??
    "Explain Analyze can't run this statement."
  );
}

export function explainAnalyzeErrorMessage(category: string): string {
  return ERRORS[category] ?? ERRORS.failed!;
}

/** Approved confirmation text (plan "Goal And Visible Result"). */
export const EXPLAIN_ANALYZE_CONFIRMATION =
  "Explain Analyze executes this statement in a local PostgreSQL read-only transaction. " +
  "Local writes to permanent tables are blocked. We roll back when it finishes and close the connection used. " +
  "Functions and extensions can still cause effects outside the transaction, including writes committed on remote servers, and can take locks. " +
  "The statement may add database load or wait for locks. " +
  "Time limit: 60 seconds; lock-wait limit: 5 seconds. " +
  "Cancel asks the server to stop; it cannot undo effects already performed.";

/** What else the user must know before confirming (plan D5, D6, D7). */
export const EXPLAIN_ANALYZE_NOTES = [
  "It runs in a new session: temporary tables and SET values from this editor are not there.",
  "Connecting and preparing (up to 10 seconds) and the rollback (up to 5 seconds) are not counted in the 60-second limit.",
  "The statement is added to this tab's query history once the server accepts the request. If you cancel or close the result before that, or no reply comes back, it may have run without a history entry.",
  "Measured times include the overhead of timing every plan node.",
];
