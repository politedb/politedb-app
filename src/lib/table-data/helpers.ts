import type { ColumnRow } from "./types";

export function isNonEmptyName(v: ColumnRow) {
  return (v.name ?? "").trim().length > 0;
}

/**
 * A load that may no longer publish (its tab changed connection, or its
 * epoch moved: profile saved again, connection refused). Thrown instead of
 * writing rows; the guarded meta setters drop the error it causes.
 */
export const STALE_LOAD = "STALE_LOAD";

export function assertCurrent(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) throw new Error(STALE_LOAD);
}

export function getErrorMessage(e: unknown) {
  if (e && typeof e === "object") {
    const rec = e as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error) return rec.error;
    if (typeof rec.message === "string" && rec.message) return rec.message;
  }
  return String(e ?? "UNKNOWN_ERROR");
}

export function parseBusyOpId(err: unknown): string | null {
  const msg = getErrorMessage(err);
  // Non-anchored: Tauri may wrap the code in a larger invoke error string.
  const m = /ERR_SQL_BUSY:([0-9a-f-]{36})/i.exec(msg);
  return m?.[1] ?? null;
}
