import type { DumpJobKind, DumpOutcome } from "src/stores/dumpJob";
import { BACKUP_CANCELLED_MESSAGE } from "./backupRun";

/** The text of an outcome the user must read, and how it reads. */
export function describeDumpOutcome(
  kind: DumpJobKind,
  outcome: DumpOutcome
): { message: string; tone: "warning" | "error" | "info" } | null {
  switch (outcome.kind) {
    case "succeeded":
    case "abandoned":
      return null;
    case "cancelled":
      return {
        message: kind === "backup" ? BACKUP_CANCELLED_MESSAGE : outcome.message,
        tone: "info",
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
