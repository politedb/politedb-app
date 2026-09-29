import type {
  HealthAttentionItem,
  HealthIndexRow,
  HealthOverview,
  HealthTableRow,
} from "./types";

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

/** True when some sessions hide backend_type so client counts are incomplete. */
export function clientBackendClassificationIncomplete(
  overview: HealthOverview | null
): boolean {
  if (!overview) return false;
  return (
    (overview.hiddenBackendTypeCountDatabase ?? 0) > 0 ||
    (overview.hiddenBackendTypeCountServer ?? 0) > 0
  );
}

export function overviewVisibilityNote(
  overview: HealthOverview | null
): string | null {
  if (!overview) return null;
  const parts: string[] = [];
  if (overview.restrictedVisibility) {
    parts.push(
      "Role visibility is restricted: some sessions show " +
        "<insufficient privilege> (or null) query text with hidden state/timing. " +
        "Active, idle, idle-in-transaction, and longest-transaction metrics are incomplete for other roles."
    );
  }
  if (clientBackendClassificationIncomplete(overview)) {
    const dbHidden = overview.hiddenBackendTypeCountDatabase ?? 0;
    const serverHidden = overview.hiddenBackendTypeCountServer ?? 0;
    parts.push(
      "Some sessions hide backend_type (role privileges), so client-backend counts " +
        "are visible-only lower bounds — not complete database/server totals" +
        (dbHidden > 0 && serverHidden > dbHidden
          ? " (including sessions outside this database)."
          : dbHidden === 0 && serverHidden > 0
            ? " (hidden sessions are outside this database)."
            : ".")
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * Build the compact Attention list from overview metrics.
 * Historical deadlocks are informational (since reset), never a current incident.
 * Temp bytes alone never produce a critical alert.
 */
export function buildAttentionItems(
  overview: HealthOverview | null
): HealthAttentionItem[] {
  if (!overview) return [];

  const items: HealthAttentionItem[] = [];

  if (overview.restrictedVisibility) {
    items.push({
      kind: "incomplete",
      tone: "incomplete",
      title: "Incomplete activity visibility",
      evidence:
        "Some session state and timing are hidden for other roles; workload indicators may be partial or unknown.",
      openSessions: true,
    });
  }

  if (clientBackendClassificationIncomplete(overview)) {
    const dbHidden = overview.hiddenBackendTypeCountDatabase ?? 0;
    items.push({
      kind: "incomplete",
      tone: "incomplete",
      title: "Incomplete client-backend classification",
      evidence:
        "Some sessions hide backend_type (role privileges). Client counts are visible-only lower bounds, not full database/server totals.",
      // Sessions tab only lists the current database; open it when DB-scope rows are hidden.
      openSessions: dbHidden > 0,
    });
  }

  const blocked = overview.blockedSessionCount;
  if (blocked != null && blocked > 0) {
    const top = overview.topBlockers
      .slice(0, 5)
      .map((b) => {
        if (b.isPreparedTransaction) {
          return `prepared xact (PID 0) blocking ${b.blockedSessionCount}`;
        }
        if (!b.inCurrentDatabase) {
          return `PID ${b.pid} (outside this database / unresolved) blocking ${b.blockedSessionCount}`;
        }
        return `PID ${b.pid} blocking ${b.blockedSessionCount}`;
      })
      .join("; ");
    const limitation = overview.hasUnresolvedBlockers
      ? " Some blockers are unresolved (other database, privileges, or prepared transaction)."
      : "";
    const waitNote = " Exact lock-wait duration unavailable.";
    items.push({
      kind: "blocked",
      tone: "actionable",
      title: `${blocked} blocked session${blocked === 1 ? "" : "s"}`,
      evidence: `${top || "Blocker details unavailable."}.${limitation}${waitNote}`,
      openSessions: true,
    });
  }

  const idleInXact = overview.idleInTransactionCount;
  if (idleInXact != null && idleInXact > 0) {
    items.push({
      kind: "idle_in_transaction",
      tone: "actionable",
      title: `${idleInXact} idle-in-transaction session${idleInXact === 1 ? "" : "s"}`,
      evidence:
        `Oldest transaction age ${formatAgeSeconds(overview.idleInTransactionOldestXactAgeSeconds)}; ` +
        `longest idle-state ${formatAgeSeconds(overview.idleInTransactionLongestIdleSeconds)} ` +
        `(transaction age ≠ idle duration; includes aborted idle transactions).`,
      openSessions: true,
    });
  }

  const deadlocks = overview.deadlocks;
  if (deadlocks != null && deadlocks > 0) {
    const since = overview.statsReset
      ? "since stats reset"
      : "since an unknown reset (observation window unknown)";
    items.push({
      kind: "deadlocks_history",
      tone: "informational",
      title: `Deadlocks history: ${deadlocks} ${since}`,
      evidence:
        "Cumulative deadlock events for this database — historical, not an ongoing blocking incident.",
      openSessions: false,
    });
  }

  // No "healthy" / "no issues" banner when empty — silence means nothing actionable.
  return items;
}

export const INDEX_SCAN_CAVEAT =
  "Zero scans does not mean an index is safe to drop — counters reset and workloads vary.";

export const DEAD_ROW_CAVEAT =
  "Live/dead tuple counts are estimates from statistics, not exact row counts.";

export const PARTITION_SIZE_NOTE =
  "Partition parents and leaves are listed separately; each row shows only its own relation size (no parent+child double-counting).";

export const TEMP_FILES_CAVEAT =
  "Temporary files and bytes are cumulative since the last statistics reset — not current disk occupancy or spill rate.";

export const DEADLOCKS_CAVEAT =
  "Deadlocks are cumulative historical events since the last statistics reset — not ongoing blocking.";

export const CONNECTIONS_TOOLTIP =
  "Client-backend counts include this application's connection and count only rows with backend_type = 'client backend'. When role privileges hide backend_type for other sessions, those rows cannot be classified and counts are shown as visible-only lower bounds — not complete totals. Database count is scoped to the current database and is not divided by the server-wide maximum. Server usage is approximate relative to configured max_connections — reserved slots, role/database limits, and poolers mean this is not available-slot capacity. Background workers are excluded.";

export const BLOCKING_LIMITATION_NOTE =
  "Blocker PIDs outside this database or hidden by privileges remain unresolved; prepared-transaction blockers appear as PID 0. Exact lock-wait duration is unavailable.";
