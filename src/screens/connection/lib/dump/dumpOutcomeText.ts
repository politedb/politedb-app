import type { DumpJobKind, DumpOutcome } from "src/stores/dumpJob";

export const BACKUP_CANCELLED_TOAST = "Backup cancelled. No file was written.";
export const RESTORE_CANCELLED_TOAST =
  "Cancelled. The transaction was not committed.";

/**
 * The toast of a cancel with nothing more to read, or null: a backup that
 * wrote nothing, or a restore/import whose transaction is known not
 * committed (rolled back, or its session closed). A failure after the
 * cancel, an unconfirmed cleanup or an unconfirmed catalog query keeps the
 * result in the modal (D15).
 */
export function quietCancelToast(
  kind: DumpJobKind,
  outcome: DumpOutcome
): string | null {
  if (outcome.kind !== "cancelled" || outcome.failure) return null;
  if (kind === "backup") {
    return outcome.rollback === "n/a" ? BACKUP_CANCELLED_TOAST : null;
  }
  if (outcome.catalogUnconfirmed) return null;
  return outcome.rollback === "rolled-back" ||
    outcome.rollback === "not-committed-closed"
    ? RESTORE_CANCELLED_TOAST
    : null;
}

/** The text of an outcome the user must read, and how it reads. */
export function describeDumpOutcome(
  outcome: DumpOutcome
): { message: string; tone: "warning" | "error" | "info" } | null {
  switch (outcome.kind) {
    case "succeeded":
      return outcome.warning
        ? { message: outcome.warning, tone: "warning" }
        : null;
    case "abandoned":
      return null;
    case "cancelled":
      return {
        message: outcome.message,
        tone:
          outcome.failure || outcome.rollback === "cleanup-unconfirmed"
            ? "warning"
            : "info",
      };
    case "stopped":
      return {
        message: outcome.message,
        tone: outcome.reason === "safety" ? "warning" : "info",
      };
    case "failed":
    case "committed-refresh-failed":
    case "commit-unknown":
      return { message: outcome.message, tone: "error" };
    case "temp-not-removed":
      return {
        message: `${outcome.after === "cancelled" ? "Backup cancelled." : `Backup failed: ${outcome.message ?? ""}`.trim()} A temporary file could not be removed next to the destination.`,
        tone: "warning",
      };
    case "file-unconfirmed":
      return {
        message:
          "The backup file's status could not be confirmed: check the destination.",
        tone: "warning",
      };
  }
}

/** The title of a job's messages. */
export function dumpJobTitle(kind: DumpJobKind, failed: boolean): string {
  if (kind === "backup") return failed ? "Backup error" : "Backup database";
  if (kind === "restore") return "Restore error";
  return "Import error";
}
