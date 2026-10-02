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
