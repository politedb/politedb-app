import type { ColumnRow } from "./types";

export function isNonEmptyName(v: ColumnRow) {
  return (v.name ?? "").trim().length > 0;
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
  const m = /^ERR_SQL_BUSY:([0-9a-f-]{36})$/i.exec(msg.trim());
  return m?.[1] ?? null;
}
