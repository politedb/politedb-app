import type { HealthIndexRow, HealthOverview, HealthTableRow } from "./types";

/** Dead-row ratio signal only — not a diagnosis. */
export function deadRowRatio(row: HealthTableRow): number | null {
  const live = row.liveTuples;
  const dead = row.deadTuples;
  if (live == null || dead == null) return null;
  const denom = live + dead;
  if (denom <= 0) return dead > 0 ? 1 : 0;
  return dead / denom;
}

/** Unknown stats stay unknown — never coerce null scans to zero for decisions. */
export function indexScanSignal(
  row: HealthIndexRow
): "unknown" | "zero" | "used" {
  if (row.idxScan == null) return "unknown";
  if (row.idxScan === 0) return "zero";
  return "used";
}

export function formatAgeSeconds(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatOptionalNumber(value: number | null, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (digits <= 0) return String(Math.round(value));
  return value.toFixed(digits);
}

export function overviewVisibilityNote(
  overview: HealthOverview | null
): string | null {
  if (!overview) return null;
  if (overview.restrictedVisibility) {
    return (
      "Role visibility is restricted: some sessions show " +
      "<insufficient privilege> (or null) query text with hidden state/timing. " +
      "Active, idle, and longest-transaction metrics are incomplete for other roles."
    );
  }
  return null;
}

export const INDEX_SCAN_CAVEAT =
  "Zero scans does not mean an index is safe to drop — counters reset and workloads vary.";

export const DEAD_ROW_CAVEAT =
  "Live/dead tuple counts are estimates from statistics, not exact row counts.";

export const PARTITION_SIZE_NOTE =
  "Partition parents and leaves are listed separately; each row shows only its own relation size (no parent+child double-counting).";
