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
 * One activity scan (CTE) feeds session, idle-in-xact, and blocking summaries
 * so they are not derived from the capped Sessions list.
 */
export function healthInspectorOverviewSql(): string {
  const queryStr = `
    WITH act AS (
      SELECT
        a.pid,
        a.datname,
        a.state,
        a.xact_start,
        a.state_change,
        a.query,
        pg_catalog.pg_blocking_pids(a.pid) AS blocker_pids
      FROM pg_catalog.pg_stat_activity a
    ),
    db_act AS (
      SELECT *
      FROM act
      WHERE datname = current_database()
    ),
    db_stats AS (
      SELECT
        d.temp_files,
        d.temp_bytes,
        d.deadlocks,
        d.stats_reset
      FROM pg_catalog.pg_stat_database d
      WHERE d.datname = current_database()
    ),
    top_blockers AS (
      SELECT
        b.blocker_pid,
        COUNT(DISTINCT b.blocked_pid)::bigint AS blocked_distinct,
        EXISTS (
          SELECT 1
          FROM db_act d
          WHERE d.pid = b.blocker_pid
        ) AS in_current_database
      FROM (
        SELECT
          d.pid AS blocked_pid,
          UNNEST(d.blocker_pids) AS blocker_pid
        FROM db_act d
        WHERE cardinality(d.blocker_pids) > 0
      ) b
      GROUP BY b.blocker_pid
    )
    SELECT
      current_database() AS database_name,
      (SELECT COUNT(*)::bigint FROM db_act) AS session_count,
      (
        SELECT COUNT(*)::bigint
        FROM db_act a
        WHERE a.state = 'active'
          AND a.pid <> pg_backend_pid()
      ) AS active_session_count,
      (
        SELECT COUNT(*)::bigint
        FROM db_act a
        WHERE a.state IS NOT NULL
          AND a.state LIKE 'idle%'
          AND a.pid <> pg_backend_pid()
      ) AS idle_session_count,
      (
        SELECT COUNT(*)::bigint
        FROM db_act a
        WHERE cardinality(a.blocker_pids) > 0
      ) AS blocked_session_count,
      (
        SELECT MAX(EXTRACT(EPOCH FROM (now() - a.xact_start)))::float8
        FROM db_act a
        WHERE a.xact_start IS NOT NULL
          AND a.pid <> pg_backend_pid()
      ) AS longest_xact_age_seconds,
      (
        SELECT COUNT(*)::bigint
        FROM db_act a
        WHERE (a.query IS NULL OR a.query = '<insufficient privilege>')
      ) AS hidden_query_count,
      (
        SELECT COUNT(*)::bigint
        FROM db_act a
        WHERE a.state IS NULL
          AND (a.query IS NULL OR a.query = '<insufficient privilege>')
      ) AS restricted_activity_count,
      pg_catalog.pg_database_size(current_database())::bigint AS database_bytes,
      (SELECT s.stats_reset FROM db_stats s) AS stats_reset,
      (
        SELECT COUNT(*)::bigint
        FROM db_act a
        WHERE a.pid <> pg_backend_pid()
          AND a.state IS NOT NULL
          AND a.state LIKE 'idle in transaction%'
      ) AS idle_in_transaction_count,
      (
        SELECT MAX(EXTRACT(EPOCH FROM (now() - a.xact_start)))::float8
        FROM db_act a
        WHERE a.pid <> pg_backend_pid()
          AND a.state IS NOT NULL
          AND a.state LIKE 'idle in transaction%'
          AND a.xact_start IS NOT NULL
      ) AS idle_in_xact_oldest_xact_age_seconds,
      (
        SELECT MAX(EXTRACT(EPOCH FROM (now() - a.state_change)))::float8
        FROM db_act a
        WHERE a.pid <> pg_backend_pid()
          AND a.state IS NOT NULL
          AND a.state LIKE 'idle in transaction%'
          AND a.state_change IS NOT NULL
      ) AS idle_in_xact_longest_idle_seconds,
      (SELECT s.temp_files FROM db_stats s) AS temp_files,
      (SELECT s.temp_bytes FROM db_stats s) AS temp_bytes,
      (SELECT s.deadlocks FROM db_stats s) AS deadlocks,
      (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'pid', t.blocker_pid,
              'blocked_count', t.blocked_distinct,
              'in_current_database', t.in_current_database,
              'is_prepared_transaction', (t.blocker_pid = 0)
            )
            ORDER BY t.blocked_distinct DESC, t.blocker_pid ASC
          ),
          '[]'::json
        )
        FROM (
          SELECT *
          FROM top_blockers
          ORDER BY blocked_distinct DESC, blocker_pid ASC
          LIMIT 5
        ) t
      ) AS top_blockers
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
 * Candidate rows ranked by the catalog page estimate before real sizes are
 * computed. Larger than the fetch limit so a stale `relpages` (it only
 * updates on VACUUM/ANALYZE) rarely pushes a big relation out of the list.
 */
export const HEALTH_INSPECTOR_SIZE_CANDIDATES = 500;

/**
 * Table live/dead estimates, maintenance timestamps, and sizes.
 * Includes partition leaves with is_partition_child so physical storage and
 * maintenance are visible. Each row reports only its own relation size
 * (no parent+child aggregation), so sizes are never double-counted.
 *
 * Sizes stat files and lock each relation, so they are computed only for the
 * candidates ranked by `pg_class.relpages` (heap + TOAST + their indexes),
 * never for every table in the database. `relation_count` tells the UI when
 * that ranking was a sample.
 */
export function healthInspectorTablesSql(): string {
  const limit = HEALTH_INSPECTOR_FETCH_LIMIT;
  const candidates = HEALTH_INSPECTOR_SIZE_CANDIDATES;
  const queryStr = `
    WITH candidates AS (
      SELECT
        t.relid,
        t.schemaname,
        t.relname,
        t.n_live_tup,
        t.n_dead_tup,
        t.last_vacuum,
        t.last_autovacuum,
        t.last_analyze,
        t.last_autoanalyze,
        c.relkind,
        c.relispartition
      FROM pg_catalog.pg_stat_user_tables t
      JOIN pg_catalog.pg_class c ON c.oid = t.relid
      LEFT JOIN pg_catalog.pg_class toast ON toast.oid = c.reltoastrelid
      LEFT JOIN LATERAL (
        SELECT SUM(ic.relpages)::bigint AS pages
        FROM pg_catalog.pg_index x
        JOIN pg_catalog.pg_class ic ON ic.oid = x.indexrelid
        WHERE x.indrelid = t.relid
          OR (c.reltoastrelid <> 0 AND x.indrelid = c.reltoastrelid)
      ) idx ON true
      ORDER BY (
          GREATEST(c.relpages, 0)::bigint
          + GREATEST(COALESCE(toast.relpages, 0), 0)::bigint
          + COALESCE(idx.pages, 0)
        ) DESC,
        t.schemaname ASC,
        t.relname ASC
      LIMIT ${candidates}
    ),
    sized AS (
      SELECT
        cand.*,
        pg_catalog.pg_table_size(cand.relid)::bigint AS table_bytes,
        pg_catalog.pg_indexes_size(cand.relid)::bigint AS indexes_bytes,
        pg_catalog.pg_total_relation_size(cand.relid)::bigint AS total_bytes
      FROM candidates cand
    )
    SELECT
      s.schemaname,
      s.relname AS table_name,
      s.n_live_tup,
      s.n_dead_tup,
      s.last_vacuum,
      s.last_autovacuum,
      s.last_analyze,
      s.last_autoanalyze,
      s.table_bytes,
      s.indexes_bytes,
      s.total_bytes,
      (s.relkind = 'p') AS is_partitioned_parent,
      COALESCE(s.relispartition, false) AS is_partition_child,
      (SELECT count(*) FROM pg_catalog.pg_stat_user_tables)::bigint AS relation_count
    FROM sized s
    ORDER BY s.total_bytes DESC NULLS LAST,
      s.schemaname ASC,
      s.relname ASC
    LIMIT ${limit}
  `;
  return regexEscape(queryStr);
}

/**
 * Index sizes and scan counters.
 * Zero scans is a signal only — never treat as safe-to-drop.
 *
 * Like tables, real sizes are computed only for candidates ranked by
 * `pg_class.relpages`.
 */
export function healthInspectorIndexesSql(): string {
  const limit = HEALTH_INSPECTOR_FETCH_LIMIT;
  const candidates = HEALTH_INSPECTOR_SIZE_CANDIDATES;
  const queryStr = `
    WITH candidates AS (
      SELECT
        i.indexrelid,
        i.schemaname,
        i.relname,
        i.indexrelname,
        i.idx_scan,
        i.idx_tup_read,
        i.idx_tup_fetch
      FROM pg_catalog.pg_stat_user_indexes i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      ORDER BY GREATEST(ic.relpages, 0) DESC,
        i.schemaname ASC,
        i.relname ASC,
        i.indexrelname ASC
      LIMIT ${candidates}
    ),
    sized AS (
      SELECT
        cand.*,
        pg_catalog.pg_relation_size(cand.indexrelid)::bigint AS index_bytes
      FROM candidates cand
    )
    SELECT
      s.schemaname,
      s.relname AS table_name,
      s.indexrelname AS index_name,
      s.idx_scan,
      s.idx_tup_read,
      s.idx_tup_fetch,
      s.index_bytes,
      (SELECT count(*) FROM pg_catalog.pg_stat_user_indexes)::bigint AS relation_count
    FROM sized s
    ORDER BY s.index_bytes DESC NULLS LAST,
      s.schemaname ASC,
      s.relname ASC,
      s.indexrelname ASC
    LIMIT ${limit}
  `;
  return regexEscape(queryStr);
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
