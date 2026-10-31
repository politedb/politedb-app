import type {
  SessionActionKind,
  SessionActionOutcome,
} from "src/lib/tauri/health-inspector-actions";
import { formatAgeSeconds } from "./signals";
import type { HealthSessionRow } from "./types";

/**
 * Which session actions a Sessions row offers. The UI hides or disables
 * what is not offered; the Rust command re-checks identity, type, name and
 * ownership on the server regardless.
 */
export type SessionActionEligibility = {
  cancel: boolean;
  terminate: boolean;
  /** This running PoliteDB's own session (application_name carries our tag). */
  ownedByThisApp: boolean;
  /** Why nothing is offered, when nothing is. */
  reason: string | null;
};

export function sessionActionEligibility(
  row: HealthSessionRow,
  instanceAppName: string | null
): SessionActionEligibility {
  const none = (reason: string, ownedByThisApp = false) => ({
    cancel: false,
    terminate: false,
    ownedByThisApp,
    reason,
  });
  if (!instanceAppName) return none("Session actions are unavailable");
  if (row.applicationName === instanceAppName) {
    return none("This app's own session", true);
  }
  if (row.pid == null || row.pid <= 0 || !row.backendToken) {
    return none("Session details are hidden from this role");
  }
  if (row.backendType !== "client backend") {
    return none("Not a client session");
  }
  if (!row.applicationName) {
    // PostgreSQL publishes new sessions before their name; unnamed ones are
    // never targeted (plan decision D10).
    return none("Session has no application name");
  }
  return {
    cancel: row.state === "active",
    terminate: true,
    ownedByThisApp: false,
    reason: null,
  };
}

/** C0/C1 controls, line breaks, and Unicode format/bidi characters. */

const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu;

/** One safe line for a confirmation: no controls or bidi tricks, capped. */
export function sanitizeDialogText(value: string | null, max: number): string {
  if (!value) return "";
  const text = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type SessionActionConfirmation = {
  title: string;
  body: string;
  okLabel: string;
  cancelLabel: string;
};

/**
 * Confirmation content. The body stands alone (the browser fallback shows no
 * title or custom button labels).
 */
export function sessionActionConfirmation(
  kind: SessionActionKind,
  row: HealthSessionRow,
  databaseLabel: string | null | undefined
): SessionActionConfirmation {
  const pid = String(row.pid);
  const details = [
    `Database: ${sanitizeDialogText(databaseLabel ?? null, 64) || "current"}`,
    `PID ${pid} · User: ${sanitizeDialogText(row.usename, 64) || "—"} · App: ${sanitizeDialogText(row.applicationName, 64) || "—"}`,
    `State: ${sanitizeDialogText(row.state, 32) || "—"} · Query age: ${formatAgeSeconds(row.queryAgeSeconds)}`,
    `Query: ${row.queryHidden ? "(hidden)" : sanitizeDialogText(row.queryText, 120) || "—"}`,
  ].join("\n");
  if (kind === "cancel") {
    return {
      title: `Cancel the query in session ${pid}?`,
      body: `Cancel the query running in session ${pid}?\n\nThis stops whatever the session is running when you confirm. The session stays connected. If the statement was inside a transaction, its client must roll it back.\n\n${details}`,
      okLabel: "Cancel query",
      cancelLabel: "Keep running",
    };
  }
  return {
    title: `Terminate session ${pid}?`,
    body: `Terminate session ${pid}?\n\nThis closes the connection. Its open transaction is rolled back.\n\n${details}`,
    okLabel: "Terminate session",
    cancelLabel: "Keep session",
  };
}

/** Fixed, privacy-safe status line for an outcome. */
export function sessionActionOutcomeMessage(
  kind: SessionActionKind,
  pid: number,
  outcome: SessionActionOutcome
): string {
  const verb = kind === "cancel" ? "Cancel" : "Terminate";
  switch (outcome) {
    case "signalled":
      return kind === "cancel"
        ? `Cancel sent to session ${pid}.`
        : `Terminate sent to session ${pid}.`;
    case "failed":
      return `PostgreSQL could not signal session ${pid}.`;
    case "not_matched":
      return `Session ${pid} is no longer running or can no longer be ${kind === "cancel" ? "cancelled" : "terminated"}.`;
    case "denied":
      return `Not permitted to signal session ${pid}. It needs the same role, pg_signal_backend, or a superuser.`;
    case "busy":
      return `${verb} not sent: no free connection. Try again.`;
    case "unavailable":
      return `${verb} not sent: the connection is unavailable.`;
    case "setup_failed":
      return `${verb} not sent: could not prepare the request.`;
    case "refused":
      return `${verb} not sent: this tab no longer uses this connection. Reconnect the tab.`;
    case "invalid":
      return `${verb} not sent: the session details are not valid.`;
    case "unknown":
      return `${verb} for session ${pid} may or may not have been sent. Refresh before trying again.`;
  }
}
