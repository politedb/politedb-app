import { formatBytesSize } from "src/utils/convert";

/**
 * Format an instant using the user's local wall clock, without timezone data.
 * Health Inspector values are display-only; the decoded/API values stay intact.
 */
export function formatHealthInspectorTimestamp(
  value: number | string | null | undefined
): string {
  if (value == null) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Prefer the chronologically latest valid timestamp among candidates.
 * Used for Last vacuum / Last analyze when both manual and automatic times exist.
 */
export function latestHealthTimestamp(
  ...values: Array<string | number | null | undefined>
): string | number | null {
  let best: string | number | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value == null) continue;
    const ms = typeof value === "number" ? value : Date.parse(String(value));
    if (!Number.isFinite(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

/**
 * Format a count without silently presenting unsafe/non-integer values as exact
 * rounded integers. Safe integers render as plain decimal strings.
 */
export function formatExactCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    return `≈${value.toExponential(4)}`;
  }
  return String(value);
}

/** Byte counts for the inspector: "0 B" rather than "0.0 B". */
export function formatInspectorBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 B";
  return formatBytesSize(value, { fractionDigits: 1 });
}

/** "just now", "2 min ago", "3 h ago", "2 d ago". */
export function formatRelativeAge(value: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "2 min ago (22:35)" in the user's local clock. */
export function formatSnapshotTime(value: number, now: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${formatRelativeAge(value, now)} (${pad(date.getHours())}:${pad(date.getMinutes())})`;
}

/** "Collected in 1.2 s" duration part. */
export function formatCollectionDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** "950", "12.3K", "152M", "1.2B" for large counters such as XID age. */
export function formatCompactCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    }
  }
  return String(Math.round(value));
}
