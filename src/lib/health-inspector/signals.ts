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
  return parts.length ? parts.join(" ") : null;
}

/** Open transactions older than this are flagged (5 minutes). */
export const LONG_TRANSACTION_WARN_SECONDS = 5 * 60;

function isLongTransaction(seconds: number | null): boolean {
  return seconds != null && seconds > LONG_TRANSACTION_WARN_SECONDS;
}

export type HealthMetricTone = "critical" | "warning" | "ok" | "neutral";

/**
 * Status colors for the overview cards. Unknown values stay neutral — never
 * green — so restricted visibility is not shown as healthy.
 */
export function overviewMetricTones(overview: HealthOverview): {
  blocked: HealthMetricTone;
  idleInTransaction: HealthMetricTone;
  longestTransaction: HealthMetricTone;
} {
  const blocked = overview.blockedSessionCount;
  const idle = overview.idleInTransactionCount;
  const longest = overview.longestXactAgeSeconds;
  const unknownActivity = overview.restrictedVisibility;
  return {
    blocked: blocked == null ? "neutral" : blocked > 0 ? "critical" : "ok",
    idleInTransaction:
      idle == null
        ? "neutral"
        : idle > 0
          ? "warning"
          : unknownActivity
            ? "neutral"
            : "ok",
    longestTransaction: isLongTransaction(longest)
      ? "warning"
      : unknownActivity
        ? "neutral"
        : "ok",
  };
}

/** Longest open transaction; null means none is running unless visibility is restricted. */
export function formatLongestTransaction(overview: HealthOverview): string {
  if (overview.longestXactAgeSeconds == null) {
    return overview.restrictedVisibility ? "—" : "None running";
  }
  return formatAgeSeconds(overview.longestXactAgeSeconds);
}

/** Current issues (actionable or incomplete data) vs. history-only notes. */
export function splitAttentionItems(items: HealthAttentionItem[]): {
  issues: HealthAttentionItem[];
  history: HealthAttentionItem[];
} {
  return {
    issues: items.filter((i) => i.tone !== "informational"),
    history: items.filter((i) => i.tone === "informational"),
  };
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
        overviewVisibilityNote(overview) ??
        "Some session state and timing are hidden for other roles; workload indicators may be partial or unknown.",
      openSessions: true,
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

  const longest = overview.longestXactAgeSeconds;
  const idleOldest = overview.idleInTransactionOldestXactAgeSeconds;
  // Skip when the longest transaction is the idle one already listed above.
  const explainedByIdle =
    idleInXact != null &&
    idleInXact > 0 &&
    idleOldest != null &&
    longest != null
      ? idleOldest >= longest
      : false;
  if (isLongTransaction(longest) && !explainedByIdle) {
    items.push({
      kind: "long_transaction",
      tone: "actionable",
      title: `Transaction open for ${formatAgeSeconds(longest)}`,
      evidence:
        "Longest open transaction in this database (excluding this Inspector connection). " +
        "Long transactions hold back VACUUM and may keep locks.",
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

  // Empty means nothing actionable in this snapshot; restricted visibility is
  // always an item, so an empty list is never shown over incomplete data.
  return items;
}

export const INDEX_SCAN_CAVEAT =
  "Zero scans does not mean an index is safe to drop — counters reset and workloads vary.";

export const DEAD_ROW_CAVEAT =
  "Live/dead tuple counts are estimates from statistics, not exact row counts.";

export const PARTITION_SIZE_NOTE =
  "Partition parents and leaves are listed separately; each row shows only its own relation size (no parent+child double-counting).";

export const SIZE_RANKING_NOTE =
  "Many relations: sizes are measured for the largest by catalog estimate (refreshed by VACUUM/ANALYZE), so a recently grown one may be missing.";

export const TEMP_FILES_CAVEAT =
  "Temporary files and bytes are cumulative since the last statistics reset — not current disk occupancy or spill rate.";

export const DEADLOCKS_CAVEAT =
  "Deadlocks are cumulative historical events since the last statistics reset — not ongoing blocking.";

export const SESSIONS_SCOPE_NOTE =
  "All backends connected to this database. Active and idle counts exclude this Inspector connection.";

export const LONGEST_TRANSACTION_NOTE =
  "Age of the oldest open transaction, excluding this Inspector connection.";

export const STATS_RESET_NOTE =
  "Cumulative counters (temp files, deadlocks, scans) count from the last statistics reset. Refresh does not reset statistics.";

export const BLOCKING_LIMITATION_NOTE =
  "Blocker PIDs outside this database or hidden by privileges remain unresolved; prepared-transaction blockers appear as PID 0. Exact lock-wait duration is unavailable.";
