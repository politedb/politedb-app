import { describe, expect, it } from "vitest";
import {
  applyListCap,
  capQueryText,
  decodeCapabilities,
  decodeIndexes,
  decodeOverview,
  decodePidArray,
  decodeSessions,
  decodeStatements,
  decodeTables,
  decodeUnknownNumber,
  isPermissionOrMissingRelationError,
  sanitizeHealthError,
} from "./decode";
import {
  HEALTH_INSPECTOR_LIST_LIMIT,
  HEALTH_INSPECTOR_QUERY_TEXT_CAP,
} from "src/lib/queries/sql/healthInspector";

describe("healthInspector decode", () => {
  it("decodes nulls, numeric strings, and large counters without coercing unknown to zero", () => {
    expect(decodeUnknownNumber(null)).toBeNull();
    expect(decodeUnknownNumber({ t: "Null" })).toBeNull();
    expect(decodeUnknownNumber({ t: "Str", v: "42" })).toBe(42);
    expect(decodeUnknownNumber({ t: "I64", v: 9007199254740991 })).toBe(
      9007199254740991
    );
    expect(decodeUnknownNumber("")).toBeNull();
    expect(decodePidArray("{10,20,30}")).toEqual([10, 20, 30]);
    expect(decodePidArray({ t: "Str", v: "{1,2}" })).toEqual([1, 2]);
  });

  it("caps lists and query text", () => {
    const rows = Array.from(
      { length: HEALTH_INSPECTOR_LIST_LIMIT + 5 },
      (_, i) => i
    );
    const capped = applyListCap(rows);
    expect(capped.rows).toHaveLength(HEALTH_INSPECTOR_LIST_LIMIT);
    expect(capped.truncated).toBe(true);
    expect(
      capQueryText("a".repeat(HEALTH_INSPECTOR_QUERY_TEXT_CAP + 10))?.length
    ).toBe(HEALTH_INSPECTOR_QUERY_TEXT_CAP);
  });

  it("decodes overview and marks restricted visibility", () => {
    const overview = decodeOverview({
      columns: [
        { name: "database_name", db_type: "name" },
        { name: "session_count", db_type: "int8" },
        { name: "active_session_count", db_type: "int8" },
        { name: "idle_session_count", db_type: "int8" },
        { name: "blocked_session_count", db_type: "int8" },
        { name: "longest_xact_age_seconds", db_type: "float8" },
        { name: "hidden_query_count", db_type: "int8" },
        { name: "restricted_activity_count", db_type: "int8" },
        { name: "database_bytes", db_type: "int8" },
        { name: "stats_reset", db_type: "timestamptz" },
      ],
      rows: [
        [
          { t: "Str", v: "app" },
          { t: "I64", v: 12 },
          { t: "I64", v: 2 },
          { t: "I64", v: 8 },
          { t: "I64", v: 1 },
          { t: "F64", v: 12.5 },
          { t: "I64", v: 3 },
          { t: "I64", v: 3 },
          { t: "I64", v: 1024 },
          { t: "Null" },
        ],
      ],
      rowCount: 1,
    });
    expect(overview.databaseName).toBe("app");
    expect(overview.sessionCount).toBe(12);
    expect(overview.restrictedVisibility).toBe(true);
    expect(overview.activeSessionCount).toBeNull();
    expect(overview.idleSessionCount).toBeNull();
    expect(overview.longestXactAgeSeconds).toBeNull();
    expect(overview.statsReset).toBeNull();
  });

  it("decodes capabilities for absent extension and custom schema", () => {
    expect(
      decodeCapabilities({ columns: [], rows: [], rowCount: 0 })
        .statementsAvailable
    ).toBe(false);

    const caps = decodeCapabilities({
      columns: [
        { name: "extension_present", db_type: "bool" },
        { name: "statements_schema", db_type: "name" },
        { name: "has_total_exec_time", db_type: "bool" },
        { name: "has_total_time", db_type: "bool" },
        { name: "has_mean_exec_time", db_type: "bool" },
        { name: "has_mean_time", db_type: "bool" },
        { name: "has_info_view", db_type: "bool" },
      ],
      rows: [[true, "monitoring", true, false, true, false, true]],
      rowCount: 1,
    });
    expect(caps.statementsAvailable).toBe(true);
    expect(caps.statementsSchema).toBe("monitoring");
    expect(caps.totalTimeColumn).toBe("total_exec_time");
  });

  it("decodes sessions/tables/indexes/statements with estimates and partitions", () => {
    const sessions = decodeSessions({
      columns: [
        { name: "pid", db_type: "int4" },
        { name: "usename", db_type: "name" },
        { name: "application_name", db_type: "text" },
        { name: "client_addr", db_type: "text" },
        { name: "state", db_type: "text" },
        { name: "wait_event_type", db_type: "text" },
        { name: "wait_event", db_type: "text" },
        { name: "backend_type", db_type: "text" },
        { name: "xact_age_seconds", db_type: "float8" },
        { name: "query_age_seconds", db_type: "float8" },
        { name: "state_age_seconds", db_type: "float8" },
        { name: "is_executing", db_type: "bool" },
        { name: "query_text", db_type: "text" },
        { name: "query_hidden", db_type: "bool" },
        { name: "is_blocked", db_type: "bool" },
        { name: "blocker_pids", db_type: "_int4" },
      ],
      rows: [
        [
          42,
          "app",
          "politedb",
          "127.0.0.1",
          "active",
          "Lock",
          "relation",
          "client backend",
          10,
          5,
          1,
          true,
          "SELECT 1",
          false,
          true,
          [7, 8],
        ],
      ],
      rowCount: 1,
    });
    expect(sessions.rows[0]?.pid).toBe(42);
    expect(sessions.rows[0]?.blockerPids).toEqual([7, 8]);
    expect(sessions.rows[0]?.isExecuting).toBe(true);

    const tables = decodeTables({
      columns: [
        { name: "schemaname", db_type: "name" },
        { name: "table_name", db_type: "name" },
        { name: "n_live_tup", db_type: "int8" },
        { name: "n_dead_tup", db_type: "int8" },
        { name: "last_vacuum", db_type: "timestamptz" },
        { name: "last_autovacuum", db_type: "timestamptz" },
        { name: "last_analyze", db_type: "timestamptz" },
        { name: "last_autoanalyze", db_type: "timestamptz" },
        { name: "table_bytes", db_type: "int8" },
        { name: "indexes_bytes", db_type: "int8" },
        { name: "total_bytes", db_type: "int8" },
        { name: "is_partitioned_parent", db_type: "bool" },
        { name: "is_partition_child", db_type: "bool" },
      ],
      rows: [
        [
          "public",
          "orders",
          { t: "I64", v: 1000 },
          { t: "Null" },
          null,
          null,
          null,
          null,
          100,
          50,
          150,
          true,
          false,
        ],
      ],
      rowCount: 1,
    });
    expect(tables.rows[0]?.liveTuples).toBe(1000);
    expect(tables.rows[0]?.deadTuples).toBeNull();
    expect(tables.rows[0]?.isPartitionedParent).toBe(true);

    const indexes = decodeIndexes({
      columns: [
        { name: "schemaname", db_type: "name" },
        { name: "table_name", db_type: "name" },
        { name: "index_name", db_type: "name" },
        { name: "idx_scan", db_type: "int8" },
        { name: "idx_tup_read", db_type: "int8" },
        { name: "idx_tup_fetch", db_type: "int8" },
        { name: "index_bytes", db_type: "int8" },
      ],
      rows: [["public", "orders", "orders_pkey", null, 0, 0, 2048]],
      rowCount: 1,
    });
    expect(indexes.rows[0]?.idxScan).toBeNull();

    const statements = decodeStatements({
      columns: [
        { name: "queryid", db_type: "int8" },
        { name: "query_text", db_type: "text" },
        { name: "query_hidden", db_type: "bool" },
        { name: "calls", db_type: "int8" },
        { name: "total_time_ms", db_type: "float8" },
        { name: "mean_time_ms", db_type: "float8" },
        { name: "rows", db_type: "int8" },
      ],
      rows: [[123, "SELECT 1", false, 10, 20.5, 2.05, 10]],
      rowCount: 1,
    });
    expect(statements.rows[0]?.totalTimeMs).toBe(20.5);
  });

  it("sanitizes errors without echoing long SQL", () => {
    expect(sanitizeHealthError(new DOMException("Aborted", "AbortError"))).toBe(
      "Cancelled"
    );
    expect(sanitizeHealthError(new Error("SQL_QUERY_TIMEOUT"))).toBe(
      "Query timed out"
    );
    const sanitized = sanitizeHealthError(
      new Error("ERROR: permission denied for relation pg_stat_activity")
    );
    expect(sanitized.toLowerCase()).toContain("permission");
  });

  it("surfaces Postgres text from ROW_STREAM_FAILED / caret dumps", () => {
    const opaque = sanitizeHealthError(
      new Error("ROW_STREAM_FAILED: db error")
    );
    // Legacy opaque payload: prefix stripped; leftover may still be useless.
    expect(opaque.toLowerCase()).not.toContain("row_stream_failed");

    const rich = sanitizeHealthError(
      new Error(
        "ROW_STREAM_FAILED: ERROR at Line 1:\nERROR: permission denied for relation pg_stat_statements\nLINE 1: SELECT * FROM pg_stat_statements\n^"
      )
    );
    expect(rich.toLowerCase()).toContain("permission denied");
    expect(rich.toLowerCase()).toContain("pg_stat_statements");
    expect(rich.toLowerCase()).not.toContain("row_stream_failed");
    expect(rich.toLowerCase()).not.toContain("select *");

    const withHint = sanitizeHealthError(
      new Error(
        "ERROR: pg_stat_statements must be loaded via shared_preload_libraries\nHINT: After adding to shared_preload_libraries, restart the server."
      )
    );
    expect(withHint.toLowerCase()).toContain("shared_preload_libraries");
    expect(withHint.toLowerCase()).toContain("hint:");
    expect(isPermissionOrMissingRelationError(withHint)).toBe(true);
    expect(isPermissionOrMissingRelationError(rich)).toBe(true);
  });
});

it("recognizes realistic restricted-role session rows", () => {
  // PostgreSQL returns query='<insufficient privilege>' with null state/timing
  // for other roles when the caller lacks pg_read_all_stats.
  const sessions = decodeSessions({
    columns: [
      { name: "pid", db_type: "int4" },
      { name: "usename", db_type: "name" },
      { name: "application_name", db_type: "text" },
      { name: "client_addr", db_type: "text" },
      { name: "state", db_type: "text" },
      { name: "wait_event_type", db_type: "text" },
      { name: "wait_event", db_type: "text" },
      { name: "backend_type", db_type: "text" },
      { name: "xact_age_seconds", db_type: "float8" },
      { name: "query_age_seconds", db_type: "float8" },
      { name: "state_age_seconds", db_type: "float8" },
      { name: "is_executing", db_type: "bool" },
      { name: "query_text", db_type: "text" },
      { name: "query_hidden", db_type: "bool" },
      { name: "is_blocked", db_type: "bool" },
      { name: "blocker_pids", db_type: "_int4" },
    ],
    rows: [
      [
        99,
        "other_role",
        "app",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        false,
        "<insufficient privilege>",
        false, // SQL flag may only check IS NULL — decoder must still hide
        false,
        [],
      ],
    ],
    rowCount: 1,
  });
  expect(sessions.rows[0]?.queryHidden).toBe(true);
  expect(sessions.rows[0]?.queryText).toBeNull();
  expect(sessions.rows[0]?.state).toBeNull();

  const overview = decodeOverview({
    columns: [
      { name: "database_name", db_type: "name" },
      { name: "session_count", db_type: "int8" },
      { name: "active_session_count", db_type: "int8" },
      { name: "idle_session_count", db_type: "int8" },
      { name: "blocked_session_count", db_type: "int8" },
      { name: "longest_xact_age_seconds", db_type: "float8" },
      { name: "hidden_query_count", db_type: "int8" },
      { name: "restricted_activity_count", db_type: "int8" },
      { name: "database_bytes", db_type: "int8" },
      { name: "stats_reset", db_type: "timestamptz" },
    ],
    // hidden_query_count=0 if SQL only checked IS NULL; restricted_activity_count=1
    rows: [["app", 5, 0, 0, 0, null, 0, 1, 2048, null]],
    rowCount: 1,
  });
  expect(overview.restrictedVisibility).toBe(true);
  expect(overview.activeSessionCount).toBeNull();
  expect(overview.idleSessionCount).toBeNull();
});

it("decodes partition leaf fixture with nonzero storage and maintenance", () => {
  const tables = decodeTables({
    columns: [
      { name: "schemaname", db_type: "name" },
      { name: "table_name", db_type: "name" },
      { name: "n_live_tup", db_type: "int8" },
      { name: "n_dead_tup", db_type: "int8" },
      { name: "last_vacuum", db_type: "timestamptz" },
      { name: "last_autovacuum", db_type: "timestamptz" },
      { name: "last_analyze", db_type: "timestamptz" },
      { name: "last_autoanalyze", db_type: "timestamptz" },
      { name: "table_bytes", db_type: "int8" },
      { name: "indexes_bytes", db_type: "int8" },
      { name: "total_bytes", db_type: "int8" },
      { name: "is_partitioned_parent", db_type: "bool" },
      { name: "is_partition_child", db_type: "bool" },
    ],
    rows: [
      [
        "public",
        "events",
        0,
        0,
        null,
        null,
        null,
        null,
        0,
        0,
        8192,
        true,
        false,
      ],
      [
        "public",
        "events_2024",
        5000,
        120,
        null,
        "2024-06-01T10:00:00.000Z",
        null,
        "2024-06-01T11:00:00.000Z",
        4_000_000,
        500_000,
        4_500_000,
        false,
        true,
      ],
    ],
    rowCount: 2,
  });
  const leaf = tables.rows.find((r) => r.tableName === "events_2024");
  expect(leaf?.isPartitionChild).toBe(true);
  expect(leaf?.totalBytes).toBe(4_500_000);
  expect(leaf?.lastAutovacuum).toBe("2024-06-01T10:00:00.000Z");
  expect(leaf?.deadTuples).toBe(120);
});
