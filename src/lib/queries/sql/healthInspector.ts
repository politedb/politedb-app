import { regexEscape } from "./shared";

/** Max rows returned to the UI per list section (stable order). */
export const HEALTH_INSPECTOR_LIST_LIMIT = 100;

/** Fetch one extra row to detect truncation without unbounded reads. */
export const HEALTH_INSPECTOR_FETCH_LIMIT = HEALTH_INSPECTOR_LIST_LIMIT + 1;

/** Cap captured query text length (characters). */
export const HEALTH_INSPECTOR_QUERY_TEXT_CAP = 2000;

/** PostgreSQL marker when the caller lacks rights to see another role's query. */
export const PG_INSUFFICIENT_PRIVILEGE_QUERY = "<insufficient privilege>";

/** True when activity query text is null or the privilege-redacted marker. */
export const SQL_ACTIVITY_QUERY_RESTRICTED =
  "(a.query IS NULL OR a.query = '<insufficient privilege>')";

/**
 * Capability probe for optional pg_stat_statements (any install schema).
 * Detects extension presence, view schema, and time-column variants across PG versions.
 */
export function healthInspectorCapabilitiesSql(): string {
  const queryStr = `
    SELECT
      e.extname IS NOT NULL AS extension_present,
      n.nspname AS statements_schema,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'total_exec_time'
          AND a.attnum > 0
          AND NOT a.attisdropped
      ) AS has_total_exec_time,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'total_time'
          AND a.attnum > 0
          AND NOT a.attisdropped
      ) AS has_total_time,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'mean_exec_time'
          AND a.attnum > 0
          AND NOT a.attisdropped
      ) AS has_mean_exec_time,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'mean_time'
          AND a.attnum > 0
          AND NOT a.attisdropped
      ) AS has_mean_time,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class ic
        JOIN pg_catalog.pg_namespace inn ON inn.oid = ic.relnamespace
        WHERE ic.relname = 'pg_stat_statements_info'
          AND inn.nspname = n.nspname
      ) AS has_info_view
    FROM pg_catalog.pg_extension e
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    LEFT JOIN pg_catalog.pg_class c
      ON c.relnamespace = e.extnamespace
     AND c.relname = 'pg_stat_statements'
    WHERE e.extname = 'pg_stat_statements'
    LIMIT 1
  `;
  return regexEscape(queryStr);
}

/**
 * Overview aggregates for the current database.
 * Uses catalogs/statistics only; no application-table scans.
 */
export function healthInspectorOverviewSql(): string {
  const queryStr = `
    SELECT
      current_database() AS database_name,
      (
        SELECT COUNT(*)::bigint
        FROM pg_catalog.pg_stat_activity a
        WHERE a.datname = current_database()
      ) AS session_count,
      (
        SELECT COUNT(*)::bigint
        FROM pg_catalog.pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.state = 'active'
          AND a.pid <> pg_backend_pid()
      ) AS active_session_count,
      (
        SELECT COUNT(*)::bigint
        FROM pg_catalog.pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.state IS NOT NULL
          AND a.state LIKE 'idle%'
      ) AS idle_session_count,
      (
        SELECT COUNT(*)::bigint
        FROM pg_catalog.pg_stat_activity a
        WHERE a.datname = current_database()
          AND cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0
      ) AS blocked_session_count,
      (
        SELECT MAX(EXTRACT(EPOCH FROM (now() - a.xact_start)))::float8
        FROM pg_catalog.pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.xact_start IS NOT NULL
      ) AS longest_xact_age_seconds,
      (
        SELECT COUNT(*)::bigint
        FROM pg_catalog.pg_stat_activity a
        WHERE a.datname = current_database()
          AND (a.query IS NULL OR a.query = '<insufficient privilege>')
      ) AS hidden_query_count,
      (
        SELECT COUNT(*)::bigint
        FROM pg_catalog.pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.state IS NULL
          AND (a.query IS NULL OR a.query = '<insufficient privilege>')
      ) AS restricted_activity_count,
      pg_catalog.pg_database_size(current_database())::bigint AS database_bytes,
      (
        SELECT stats_reset
        FROM pg_catalog.pg_stat_database d
        WHERE d.datname = current_database()
      ) AS stats_reset
  `;
  return regexEscape(queryStr);
}

/**
 * Sessions in the current database (stable: active first, then query age).
 * Query text is capped; blocker PIDs via pg_blocking_pids.
 */
export function healthInspectorSessionsSql(): string {
  const limit = HEALTH_INSPECTOR_FETCH_LIMIT;
  const cap = HEALTH_INSPECTOR_QUERY_TEXT_CAP;
  const queryStr = `
    SELECT
      a.pid,
      a.usename,
      a.application_name,
      a.client_addr::text AS client_addr,
      a.state,
      a.wait_event_type,
      a.wait_event,
      a.backend_type,
      EXTRACT(EPOCH FROM (now() - a.xact_start))::float8 AS xact_age_seconds,
      EXTRACT(EPOCH FROM (now() - a.query_start))::float8 AS query_age_seconds,
      EXTRACT(EPOCH FROM (now() - a.state_change))::float8 AS state_age_seconds,
      (a.state = 'active' AND COALESCE(a.wait_event_type, '') <> 'Client') AS is_executing,
      LEFT(a.query, ${cap}) AS query_text,
      (a.query IS NULL OR a.query = '<insufficient privilege>') AS query_hidden,
      cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0 AS is_blocked,
      pg_catalog.pg_blocking_pids(a.pid) AS blocker_pids
    FROM pg_catalog.pg_stat_activity a
    WHERE a.datname = current_database()
    ORDER BY
      CASE
        WHEN a.state = 'active' THEN 0
        WHEN a.state IS NOT NULL AND a.state LIKE 'idle in transaction%' THEN 1
        ELSE 2
      END,
      a.query_start ASC NULLS LAST,
      a.pid ASC
    LIMIT ${limit}
  `;
  return regexEscape(queryStr);
}

export type HealthInspectorStatementsCapability = {
  schema: string;
  totalTimeColumn: "total_exec_time" | "total_time";
  meanTimeColumn: "mean_exec_time" | "mean_time" | null;
  hasInfoView: boolean;
};

/**
 * Top statements from pg_stat_statements for the current database.
 * Column names adapt to PG version via capability detection.
 */
export function healthInspectorStatementsSql(
  cap: HealthInspectorStatementsCapability
): string {
  const schema = quoteIdent(cap.schema);
  const totalCol = cap.totalTimeColumn;
  const meanExpr =
    cap.meanTimeColumn != null
      ? `s.${cap.meanTimeColumn}`
      : `CASE WHEN s.calls > 0 THEN s.${totalCol} / s.calls ELSE NULL END`;
  const limit = HEALTH_INSPECTOR_FETCH_LIMIT;
  const textCap = HEALTH_INSPECTOR_QUERY_TEXT_CAP;
  const queryStr = `
    SELECT
      s.queryid,
      LEFT(s.query, ${textCap}) AS query_text,
      (s.query IS NULL) AS query_hidden,
      s.calls,
      s.${totalCol} AS total_time_ms,
      ${meanExpr} AS mean_time_ms,
      s.rows
    FROM ${schema}.pg_stat_statements s
    WHERE s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
    ORDER BY s.${totalCol} DESC NULLS LAST, s.calls DESC NULLS LAST, s.queryid ASC NULLS LAST
    LIMIT ${limit}
  `;
  return regexEscape(queryStr);
}

/** Optional reset/observation metadata when pg_stat_statements_info exists. */
export function healthInspectorStatementsInfoSql(schema: string): string {
  const s = quoteIdent(schema);
  const queryStr = `
    SELECT
      dealloc,
      stats_reset
    FROM ${s}.pg_stat_statements_info
    LIMIT 1
  `;
  return regexEscape(queryStr);
}

/**
 * Table live/dead estimates, maintenance timestamps, and sizes.
 * Includes partition leaves with is_partition_child so physical storage and
 * maintenance are visible. Each row reports only its own relation size
 * (no parent+child aggregation), so sizes are never double-counted.
 */
export function healthInspectorTablesSql(): string {
  const limit = HEALTH_INSPECTOR_FETCH_LIMIT;
  const queryStr = `
    SELECT
      t.schemaname,
      t.relname AS table_name,
      t.n_live_tup,
      t.n_dead_tup,
      t.last_vacuum,
      t.last_autovacuum,
      t.last_analyze,
      t.last_autoanalyze,
      pg_catalog.pg_table_size(t.relid)::bigint AS table_bytes,
      pg_catalog.pg_indexes_size(t.relid)::bigint AS indexes_bytes,
      pg_catalog.pg_total_relation_size(t.relid)::bigint AS total_bytes,
      (c.relkind = 'p') AS is_partitioned_parent,
      COALESCE(c.relispartition, false) AS is_partition_child
    FROM pg_catalog.pg_stat_user_tables t
    JOIN pg_catalog.pg_class c ON c.oid = t.relid
    ORDER BY pg_catalog.pg_total_relation_size(t.relid) DESC NULLS LAST,
      t.schemaname ASC,
      t.relname ASC
    LIMIT ${limit}
  `;
  return regexEscape(queryStr);
}

/**
 * Index sizes and scan counters.
 * Zero scans is a signal only — never treat as safe-to-drop.
 */
export function healthInspectorIndexesSql(): string {
  const limit = HEALTH_INSPECTOR_FETCH_LIMIT;
  const queryStr = `
    SELECT
      i.schemaname,
      i.relname AS table_name,
      i.indexrelname AS index_name,
      i.idx_scan,
      i.idx_tup_read,
      i.idx_tup_fetch,
      pg_catalog.pg_relation_size(i.indexrelid)::bigint AS index_bytes
    FROM pg_catalog.pg_stat_user_indexes i
    ORDER BY pg_catalog.pg_relation_size(i.indexrelid) DESC NULLS LAST,
      i.schemaname ASC,
      i.relname ASC,
      i.indexrelname ASC
    LIMIT ${limit}
  `;
  return regexEscape(queryStr);
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
