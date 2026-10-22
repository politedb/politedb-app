import type {
  HealthAttentionItem,
  HealthIndexRow,
  HealthOverview,
  HealthServerMetrics,
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

/** Tables flagged for VACUUM: a fifth of the rows dead, and enough of them to matter. */
export const VACUUM_DEAD_RATIO = 0.2;
export const VACUUM_MIN_DEAD_ROWS = 1_000;

export function needsVacuum(row: HealthTableRow): boolean {
  const ratio = deadRowRatio(row);
  return (
    ratio != null &&
    ratio >= VACUUM_DEAD_RATIO &&
    (row.deadTuples ?? 0) >= VACUUM_MIN_DEAD_ROWS
  );
}

/**
 * Zero scans since the stats reset on an index that enforces nothing. A signal
 * to investigate, not proof it is safe to drop (see INDEX_SCAN_CAVEAT).
 */
export function isUnusedIndex(row: HealthIndexRow): boolean {
  return indexScanSignal(row) === "zero" && !row.enforcesConstraint;
}

/** Case-insensitive match of every whitespace-separated term in any field. */
export function matchesHealthFilter(
  fields: Array<string | number | null | undefined>,
  query: string
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields
    .filter((f) => f != null && f !== "")
    .map((f) => String(f).toLowerCase())
    .join("\n");
  return terms.every((term) => haystack.includes(term));
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

/** PostgreSQL stops assigning transaction IDs near 2^31 of age. */
export const XID_WRAPAROUND_LIMIT = 2 ** 31;
/** Below this many block requests the cache hit ratio is noise. */
const CACHE_HIT_MIN_BLOCKS = 1_000;

export type HealthServerSignals = {
  xidAgeRatio: number | null;
  xid: HealthMetricTone;
  connectionRatio: number | null;
  connections: HealthMetricTone;
  cacheHitRatio: number | null;
  cache: HealthMetricTone;
  replicationLagSeconds: number | null;
  replication: HealthMetricTone;
};

/**
 * Thresholds:
 * - XID age: amber past 2× autovacuum_freeze_max_age (autovacuum is falling
 *   behind) or half the wraparound limit; red at 75 % of the limit.
 * - Connections (vs max_connections minus superuser-reserved): amber ≥ 80 %,
 *   red ≥ 95 %.
 * - Cache hit ratio: amber below 90 % once there is enough traffic.
 * - Replica lag: amber > 1 min, red > 10 min. A standby's replay lag also
 *   grows while the primary is idle, so it is amber at most.
 */
export function serverMetricSignals(
  server: HealthServerMetrics
): HealthServerSignals {
  const xidAgeRatio =
    server.maxXidAge == null ? null : server.maxXidAge / XID_WRAPAROUND_LIMIT;
  const freezeBehind =
    server.maxXidAge != null &&
    server.autovacuumFreezeMaxAge != null &&
    server.maxXidAge > 2 * server.autovacuumFreezeMaxAge;
  const xid: HealthMetricTone =
    xidAgeRatio == null
      ? "neutral"
      : xidAgeRatio >= 0.75
        ? "critical"
        : xidAgeRatio >= 0.5 || freezeBehind
          ? "warning"
          : "ok";

  const usable =
    server.maxConnections == null
      ? null
      : server.maxConnections - (server.reservedConnections ?? 0);
  const connectionRatio =
    usable == null || usable <= 0 || server.clientConnections == null
      ? null
      : server.clientConnections / usable;
  const connections: HealthMetricTone =
    connectionRatio == null
      ? "neutral"
      : connectionRatio >= 0.95
        ? "critical"
        : connectionRatio >= 0.8
          ? "warning"
          : "ok";

  const blocks =
    server.blocksHit == null || server.blocksRead == null
      ? null
      : server.blocksHit + server.blocksRead;
  const cacheHitRatio =
    blocks == null || blocks < CACHE_HIT_MIN_BLOCKS
      ? null
      : server.blocksHit! / blocks;
  const cache: HealthMetricTone =
    cacheHitRatio == null ? "neutral" : cacheHitRatio < 0.9 ? "warning" : "ok";

  const replicationLagSeconds = server.isStandby
    ? server.standbyReplayLagSeconds
    : server.maxReplicaLagSeconds;
  let replication: HealthMetricTone = "neutral";
  if (replicationLagSeconds != null) {
    if (server.isStandby) {
      replication = replicationLagSeconds > 300 ? "warning" : "ok";
    } else {
      replication =
        replicationLagSeconds > 600
          ? "critical"
          : replicationLagSeconds > 60
            ? "warning"
            : "ok";
    }
  }

  return {
    xidAgeRatio,
    xid,
    connectionRatio,
    connections,
    cacheHitRatio,
    cache,
    replicationLagSeconds,
    replication,
  };
}

export type ServerCheckState = "pending" | "complete" | "incomplete";

/**
 * Whether the server checks ran far enough to back an "All clear": failed,
 * unavailable or cancelled checks, and checks that came back without the key
 * values (XID age, connections), are incomplete.
 */
export function serverCheckState(
  section: { status: string; data: HealthServerMetrics | null } | undefined,
  loading: boolean
): ServerCheckState {
  if (!section || (section.status === "loading" && loading)) return "pending";
  const server = section.status === "ready" ? section.data : null;
  if (
    !server ||
    server.maxXidAge == null ||
    server.clientConnections == null ||
    server.maxConnections == null
  ) {
    return "incomplete";
  }
  return "complete";
}

/** Attention items for server-wide conditions. */
export function buildServerAttentionItems(
  server: HealthServerMetrics | null
): HealthAttentionItem[] {
  if (!server) return [];
  const signals = serverMetricSignals(server);
  const items: HealthAttentionItem[] = [];
  if (signals.xid === "warning" || signals.xid === "critical") {
    items.push({
      kind: "xid_wraparound",
      tone: "actionable",
      critical: signals.xid === "critical",
      title: `Transaction ID age at ${formatPercent(signals.xidAgeRatio)} of the wraparound limit`,
      evidence:
        "Autovacuum must freeze old rows before transaction IDs wrap around; past the limit PostgreSQL stops accepting writes. Check long transactions, abandoned replication slots and prepared transactions holding back VACUUM.",
      openSessions: false,
    });
  }
  if (signals.connections === "warning" || signals.connections === "critical") {
    items.push({
      kind: "connections_near_limit",
      tone: "actionable",
      critical: signals.connections === "critical",
      title: `Connections at ${formatPercent(signals.connectionRatio)} of usable slots`,
      evidence:
        "Client connections across all databases, compared with max_connections minus reserved slots. New connections from ordinary roles fail once those slots are full; superusers and roles allowed to use reserved slots have a little more room.",
      openSessions: true,
    });
  }
  if (signals.replication === "warning" || signals.replication === "critical") {
    items.push({
      kind: "replication_lag",
      tone: "actionable",
      critical: signals.replication === "critical",
      title: server.isStandby
        ? `Standby is ${formatAgeSeconds(signals.replicationLagSeconds)} behind`
        : `Replica lag ${formatAgeSeconds(signals.replicationLagSeconds)}`,
      evidence: server.isStandby
        ? "Time since this standby replayed the last transaction. It also grows when the primary has no writes."
        : "Worst replay lag among connected replicas (pg_stat_replication).",
      openSessions: false,
    });
  }
  return items;
}

export function formatPercent(ratio: number | null, digits = 0): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
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
      critical: true,
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

export const CONNECTIONS_NOTE =
  "Client connections across all databases on this server, out of max_connections. The percentage leaves out reserved slots. Counting other roles' sessions needs pg_read_all_stats (or pg_monitor).";

export const CONNECTIONS_RESTRICTED_DETAIL = "Needs pg_read_all_stats";

export const XID_AGE_NOTE =
  "Age of the oldest unfrozen transaction ID across all databases. Autovacuum freezes rows to keep it far below the ~2.1 billion wraparound limit.";

export const CACHE_HIT_NOTE =
  "Share of block reads served from shared buffers in this database since the last stats reset. Reads served by the OS cache count as misses; analytics workloads run lower.";

export const REPLICATION_NOTE =
  "Primary: connected replicas and their worst replay lag. Standby: time since the last replayed transaction. Lag needs pg_read_all_stats (or pg_monitor) to be visible.";

export const BLOCKING_LIMITATION_NOTE =
  "Blocker PIDs outside this database or hidden by privileges remain unresolved; prepared-transaction blockers appear as PID 0. Exact lock-wait duration is unavailable.";
