import type { ColumnMeta, QueryResult } from "src/lib/tauri";
import {
  HEALTH_INSPECTOR_LIST_LIMIT,
  HEALTH_INSPECTOR_QUERY_TEXT_CAP,
  PG_INSUFFICIENT_PRIVILEGE_QUERY,
} from "src/lib/queries/sql/healthInspector";
import type {
  HealthBlockerSummary,
  HealthInspectorCapabilities,
  HealthIndexRow,
  HealthOverview,
  HealthSessionRow,
  HealthStatementRow,
  HealthStatementsInfo,
  HealthTableRow,
} from "./types";

function cellPrimitive(cell: unknown): unknown {
  if (cell == null) return null;
  if (typeof cell !== "object") return cell;
  const tagged = cell as { t?: string; v?: unknown };
  if (tagged.t === "Null") return null;
  if (tagged.t === "I64" || tagged.t === "F64" || tagged.t === "Bool") {
    return tagged.v ?? null;
  }
  if (tagged.t === "Str" || tagged.t === "Json") {
    return tagged.v == null ? null : String(tagged.v);
  }
  if ("v" in tagged) return tagged.v ?? null;
  return cell;
}

export function decodeUnknownNumber(value: unknown): number | null {
  const prim = cellPrimitive(value);
  if (prim == null) return null;
  if (typeof prim === "number") {
    return Number.isFinite(prim) ? prim : null;
  }
  if (typeof prim === "bigint") {
    const n = Number(prim);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof prim === "string") {
    const trimmed = prim.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof prim === "boolean") return prim ? 1 : 0;
  return null;
}

export function decodeUnknownString(value: unknown): string | null {
  const prim = cellPrimitive(value);
  if (prim == null) return null;
  if (typeof prim === "string") return prim;
  if (typeof prim === "number" || typeof prim === "boolean")
    return String(prim);
  if (typeof prim === "bigint") return prim.toString();
  if (Array.isArray(prim)) {
    return prim.map((x) => decodeUnknownString(x) ?? "").join(",");
  }
  return null;
}

export function decodeUnknownBool(value: unknown): boolean {
  const prim = cellPrimitive(value);
  if (typeof prim === "boolean") return prim;
  if (typeof prim === "number") return prim !== 0;
  if (typeof prim === "string") {
    const t = prim.trim().toLowerCase();
    if (t === "t" || t === "true" || t === "1" || t === "yes") return true;
    if (t === "f" || t === "false" || t === "0" || t === "no") return false;
  }
  return false;
}

export function decodePidArray(value: unknown): number[] {
  const prim = cellPrimitive(value);
  if (prim == null) return [];
  if (Array.isArray(prim)) {
    return prim
      .map((x) => decodeUnknownNumber(x))
      .filter((n): n is number => n != null && Number.isFinite(n));
  }
  if (typeof prim === "string") {
    const cleaned = prim.replace(/[{}]/g, "").trim();
    if (!cleaned) return [];
    return cleaned
      .split(",")
      .map((p) => decodeUnknownNumber(p.trim()))
      .filter((n): n is number => n != null && Number.isFinite(n));
  }
  const single = decodeUnknownNumber(prim);
  return single == null ? [] : [single];
}

function colIndex(columns: ColumnMeta[], name: string): number {
  const lower = name.toLowerCase();
  return columns.findIndex((c) => String(c.name ?? "").toLowerCase() === lower);
}

function cellAt(row: unknown[], columns: ColumnMeta[], name: string): unknown {
  const idx = colIndex(columns, name);
  if (idx < 0 || idx >= row.length) return null;
  return row[idx];
}

export function applyListCap<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length > HEALTH_INSPECTOR_LIST_LIMIT) {
    return {
      rows: rows.slice(0, HEALTH_INSPECTOR_LIST_LIMIT),
      truncated: true,
    };
  }
  return { rows, truncated: false };
}

export function capQueryText(text: string | null): string | null {
  if (text == null) return null;
  if (text.length <= HEALTH_INSPECTOR_QUERY_TEXT_CAP) return text;
  return text.slice(0, HEALTH_INSPECTOR_QUERY_TEXT_CAP);
}

/** PostgreSQL redacts other roles' activity as this exact query string. */
export function isRestrictedActivityQuery(text: string | null): boolean {
  return text == null || text === PG_INSUFFICIENT_PRIVILEGE_QUERY;
}

export function decodeCapabilities(
  result: QueryResult
): HealthInspectorCapabilities {
  const row = result.rows[0];
  if (!row) {
    return {
      statementsAvailable: false,
      statementsSchema: null,
      totalTimeColumn: null,
      meanTimeColumn: null,
      hasInfoView: false,
      unavailableReason:
        "pg_stat_statements extension is not installed in this database.",
    };
  }
  const cols = result.columns;
  const present = decodeUnknownBool(cellAt(row, cols, "extension_present"));
  const schema = decodeUnknownString(cellAt(row, cols, "statements_schema"));
  const hasExec = decodeUnknownBool(cellAt(row, cols, "has_total_exec_time"));
  const hasTotal = decodeUnknownBool(cellAt(row, cols, "has_total_time"));
  const hasMeanExec = decodeUnknownBool(
    cellAt(row, cols, "has_mean_exec_time")
  );
  const hasMean = decodeUnknownBool(cellAt(row, cols, "has_mean_time"));
  const hasInfo = decodeUnknownBool(cellAt(row, cols, "has_info_view"));

  if (!present || !schema) {
    return {
      statementsAvailable: false,
      statementsSchema: null,
      totalTimeColumn: null,
      meanTimeColumn: null,
      hasInfoView: false,
      unavailableReason:
        "pg_stat_statements extension is not installed in this database.",
    };
  }

  const totalTimeColumn = hasExec
    ? "total_exec_time"
    : hasTotal
      ? "total_time"
      : null;
  if (!totalTimeColumn) {
    return {
      statementsAvailable: false,
      statementsSchema: schema,
      totalTimeColumn: null,
      meanTimeColumn: null,
      hasInfoView: hasInfo,
      unavailableReason:
        "pg_stat_statements is present but required time columns are unavailable.",
    };
  }

  return {
    statementsAvailable: true,
    statementsSchema: schema,
    totalTimeColumn,
    meanTimeColumn: hasMeanExec
      ? "mean_exec_time"
      : hasMean
        ? "mean_time"
        : null,
    hasInfoView: hasInfo,
    unavailableReason: null,
  };
}

export function decodeTopBlockers(value: unknown): HealthBlockerSummary[] {
  const prim = cellPrimitive(value);
  let parsed: unknown = prim;
  if (typeof prim === "string") {
    const trimmed = prim.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const rows: HealthBlockerSummary[] = [];
  for (const item of parsed) {
    if (item == null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const pid = decodeUnknownNumber(obj.pid);
    if (pid == null || !Number.isFinite(pid)) continue;
    const blocked = decodeUnknownNumber(
      obj.blocked_count ?? obj.blockedSessionCount
    );
    rows.push({
      pid,
      blockedSessionCount: blocked ?? 0,
      inCurrentDatabase: decodeUnknownBool(
        obj.in_current_database ?? obj.inCurrentDatabase
      ),
      isPreparedTransaction:
        pid === 0 ||
        decodeUnknownBool(
          obj.is_prepared_transaction ?? obj.isPreparedTransaction
        ),
    });
  }

  // Deterministic: blocked desc, pid asc (SQL already orders; re-sort for safety).
  rows.sort((a, b) => {
    if (b.blockedSessionCount !== a.blockedSessionCount) {
      return b.blockedSessionCount - a.blockedSessionCount;
    }
    return a.pid - b.pid;
  });
  return rows.slice(0, 5);
}

export function decodeOverview(result: QueryResult): HealthOverview {
  const row = result.rows[0] ?? [];
  const cols = result.columns;
  const hidden = decodeUnknownNumber(cellAt(row, cols, "hidden_query_count"));
  const restrictedActivity = decodeUnknownNumber(
    cellAt(row, cols, "restricted_activity_count")
  );
  const restrictedVisibility =
    (hidden ?? 0) > 0 || (restrictedActivity ?? 0) > 0;

  // When other roles' state/timing are hidden, active/idle/longest-txn counts
  // based on visible state alone are incomplete — surface as unknown rather
  // than trustworthy zeroes.
  const active = decodeUnknownNumber(cellAt(row, cols, "active_session_count"));
  const idle = decodeUnknownNumber(cellAt(row, cols, "idle_session_count"));
  const longest = decodeUnknownNumber(
    cellAt(row, cols, "longest_xact_age_seconds")
  );
  const idleInXact = decodeUnknownNumber(
    cellAt(row, cols, "idle_in_transaction_count")
  );
  const idleInXactOldest = decodeUnknownNumber(
    cellAt(row, cols, "idle_in_xact_oldest_xact_age_seconds")
  );
  const idleInXactLongestIdle = decodeUnknownNumber(
    cellAt(row, cols, "idle_in_xact_longest_idle_seconds")
  );

  const topBlockers = decodeTopBlockers(cellAt(row, cols, "top_blockers"));
  const hasUnresolvedBlockers = topBlockers.some(
    (b) => b.isPreparedTransaction || !b.inCurrentDatabase
  );

  return {
    databaseName: decodeUnknownString(cellAt(row, cols, "database_name")),
    sessionCount: decodeUnknownNumber(cellAt(row, cols, "session_count")),
    activeSessionCount: restrictedVisibility ? null : active,
    idleSessionCount: restrictedVisibility ? null : idle,
    blockedSessionCount: decodeUnknownNumber(
      cellAt(row, cols, "blocked_session_count")
    ),
    longestXactAgeSeconds: restrictedVisibility ? null : longest,
    hiddenQueryCount: hidden,
    restrictedActivityCount: restrictedActivity,
    databaseBytes: decodeUnknownNumber(cellAt(row, cols, "database_bytes")),
    statsReset: decodeUnknownString(cellAt(row, cols, "stats_reset")),
    restrictedVisibility,
    idleInTransactionCount: restrictedVisibility ? null : idleInXact,
    idleInTransactionOldestXactAgeSeconds: restrictedVisibility
      ? null
      : idleInXactOldest,
    idleInTransactionLongestIdleSeconds: restrictedVisibility
      ? null
      : idleInXactLongestIdle,
    topBlockers,
    hasUnresolvedBlockers,
    lockWaitDurationAvailable: false,
    tempFiles: decodeUnknownNumber(cellAt(row, cols, "temp_files")),
    tempBytes: decodeUnknownNumber(cellAt(row, cols, "temp_bytes")),
    deadlocks: decodeUnknownNumber(cellAt(row, cols, "deadlocks")),
  };
}

export function decodeSessions(result: QueryResult): {
  rows: HealthSessionRow[];
  truncated: boolean;
} {
  const mapped = result.rows.map((row) => {
    const cols = result.columns;
    return {
      pid: decodeUnknownNumber(cellAt(row, cols, "pid")),
      usename: decodeUnknownString(cellAt(row, cols, "usename")),
      applicationName: decodeUnknownString(
        cellAt(row, cols, "application_name")
      ),
      clientAddr: decodeUnknownString(cellAt(row, cols, "client_addr")),
      state: decodeUnknownString(cellAt(row, cols, "state")),
      waitEventType: decodeUnknownString(cellAt(row, cols, "wait_event_type")),
      waitEvent: decodeUnknownString(cellAt(row, cols, "wait_event")),
      backendType: decodeUnknownString(cellAt(row, cols, "backend_type")),
      xactAgeSeconds: decodeUnknownNumber(
        cellAt(row, cols, "xact_age_seconds")
      ),
      queryAgeSeconds: decodeUnknownNumber(
        cellAt(row, cols, "query_age_seconds")
      ),
      stateAgeSeconds: decodeUnknownNumber(
        cellAt(row, cols, "state_age_seconds")
      ),
      isExecuting: decodeUnknownBool(cellAt(row, cols, "is_executing")),
      queryText: (() => {
        const raw = decodeUnknownString(cellAt(row, cols, "query_text"));
        if (isRestrictedActivityQuery(raw)) return null;
        return capQueryText(raw);
      })(),
      queryHidden:
        decodeUnknownBool(cellAt(row, cols, "query_hidden")) ||
        isRestrictedActivityQuery(
          decodeUnknownString(cellAt(row, cols, "query_text"))
        ),
      isBlocked: decodeUnknownBool(cellAt(row, cols, "is_blocked")),
      blockerPids: decodePidArray(cellAt(row, cols, "blocker_pids")),
    } satisfies HealthSessionRow;
  });
  return applyListCap(mapped);
}

export function decodeStatements(result: QueryResult): {
  rows: HealthStatementRow[];
  truncated: boolean;
} {
  const mapped = result.rows.map((row) => {
    const cols = result.columns;
    return {
      queryId: decodeUnknownString(cellAt(row, cols, "queryid")),
      queryText: capQueryText(
        decodeUnknownString(cellAt(row, cols, "query_text"))
      ),
      queryHidden: decodeUnknownBool(cellAt(row, cols, "query_hidden")),
      calls: decodeUnknownNumber(cellAt(row, cols, "calls")),
      totalTimeMs: decodeUnknownNumber(cellAt(row, cols, "total_time_ms")),
      meanTimeMs: decodeUnknownNumber(cellAt(row, cols, "mean_time_ms")),
      rows: decodeUnknownNumber(cellAt(row, cols, "rows")),
    } satisfies HealthStatementRow;
  });
  return applyListCap(mapped);
}

export function decodeStatementsInfo(
  result: QueryResult
): HealthStatementsInfo | null {
  const row = result.rows[0];
  if (!row) return null;
  const cols = result.columns;
  return {
    dealloc: decodeUnknownNumber(cellAt(row, cols, "dealloc")),
    statsReset: decodeUnknownString(cellAt(row, cols, "stats_reset")),
  };
}

export function decodeTables(result: QueryResult): {
  rows: HealthTableRow[];
  truncated: boolean;
} {
  const mapped = result.rows.map((row) => {
    const cols = result.columns;
    return {
      schema: decodeUnknownString(cellAt(row, cols, "schemaname")),
      tableName: decodeUnknownString(cellAt(row, cols, "table_name")),
      liveTuples: decodeUnknownNumber(cellAt(row, cols, "n_live_tup")),
      deadTuples: decodeUnknownNumber(cellAt(row, cols, "n_dead_tup")),
      lastVacuum: decodeUnknownString(cellAt(row, cols, "last_vacuum")),
      lastAutovacuum: decodeUnknownString(cellAt(row, cols, "last_autovacuum")),
      lastAnalyze: decodeUnknownString(cellAt(row, cols, "last_analyze")),
      lastAutoAnalyze: decodeUnknownString(
        cellAt(row, cols, "last_autoanalyze")
      ),
      tableBytes: decodeUnknownNumber(cellAt(row, cols, "table_bytes")),
      indexesBytes: decodeUnknownNumber(cellAt(row, cols, "indexes_bytes")),
      totalBytes: decodeUnknownNumber(cellAt(row, cols, "total_bytes")),
      isPartitionedParent: decodeUnknownBool(
        cellAt(row, cols, "is_partitioned_parent")
      ),
      isPartitionChild: decodeUnknownBool(
        cellAt(row, cols, "is_partition_child")
      ),
    } satisfies HealthTableRow;
  });
  return applyListCap(mapped);
}

export function decodeIndexes(result: QueryResult): {
  rows: HealthIndexRow[];
  truncated: boolean;
} {
  const mapped = result.rows.map((row) => {
    const cols = result.columns;
    return {
      schema: decodeUnknownString(cellAt(row, cols, "schemaname")),
      tableName: decodeUnknownString(cellAt(row, cols, "table_name")),
      indexName: decodeUnknownString(cellAt(row, cols, "index_name")),
      idxScan: decodeUnknownNumber(cellAt(row, cols, "idx_scan")),
      idxTupRead: decodeUnknownNumber(cellAt(row, cols, "idx_tup_read")),
      idxTupFetch: decodeUnknownNumber(cellAt(row, cols, "idx_tup_fetch")),
      indexBytes: decodeUnknownNumber(cellAt(row, cols, "index_bytes")),
    } satisfies HealthIndexRow;
  });
  return applyListCap(mapped);
}

/** Sanitize errors for UI — never echo SQL or long raw driver payloads. */
export function sanitizeHealthError(err: unknown): string {
  if (err && typeof err === "object" && (err as Error).name === "AbortError") {
    return "Cancelled";
  }
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err ?? "Unknown error");
  if (raw === "SQL_QUERY_TIMEOUT" || raw.includes("SQL_QUERY_TIMEOUT")) {
    return "Query timed out";
  }
  if (raw.includes("ERR_SQL_BUSY")) {
    return "Connection was busy; try again";
  }

  // Drop opaque engine stream prefixes; keep the Postgres body.
  let cleaned = raw
    .replace(
      /^(ROW_STREAM_FAILED|QUERY_FAILED|TX_COMMIT_FAILED|SET_READ_ONLY_FAILED|POOL_GET_FAILED):\s*/i,
      ""
    )
    .replace(/^ERROR at Line \d+:\s*/i, "")
    .trim();

  // Prefer severity line + optional DETAIL/HINT; drop LINE caret / SQL dump.
  const severityLine = cleaned.match(
    /^(ERROR|FATAL|PANIC|WARNING|NOTICE):\s*[^\n]+/i
  );
  if (severityLine) {
    let primary = severityLine[0];
    const detail = cleaned.match(/\nDETAIL:\s*[^\n]+/i);
    const hint = cleaned.match(/\nHINT:\s*[^\n]+/i);
    if (detail) primary += detail[0];
    if (hint) primary += hint[0];
    cleaned = primary;
  }

  // Strip likely SQL / identifier-heavy payloads
  cleaned = cleaned
    .replace(/['`][^'`]{20,}['`]/g, "…")
    .replace(/\b(SELECT|FROM|WHERE|JOIN)\b[\s\S]{0,200}/gi, "…")
    .slice(0, 280)
    .trim();
  return cleaned || "Request failed";
}

export function isPermissionOrMissingRelationError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("permission denied") ||
    m.includes("insufficient privilege") ||
    m.includes("does not exist") ||
    m.includes("undefined table") ||
    m.includes("undefined column") ||
    m.includes("must be superuser") ||
    m.includes("must be owner") ||
    m.includes("shared_preload_libraries") ||
    m.includes("pg_stat_statements")
  );
}
