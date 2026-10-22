import { describe, expect, it, vi } from "vitest";
import {
  HEALTH_INSPECTOR_MAX_STATEMENTS,
  collectHealthInspectorSnapshot,
} from "./health-inspector";
import type { QueryResult } from "./types";

function result(columns: string[], rows: any[][] = []): QueryResult {
  return {
    columns: columns.map((name) => ({ name, db_type: "text" })),
    rows,
    rowCount: rows.length,
  };
}

describe("collectHealthInspectorSnapshot", () => {
  it("runs a bounded sequential snapshot and degrades missing statements", async () => {
    const calls: string[] = [];
    const runSql = vi.fn(async (_conn: string, sql: string) => {
      calls.push(sql);
      if (sql.includes("pg_database_size")) {
        return result(
          [
            "database_name",
            "session_count",
            "active_session_count",
            "idle_session_count",
            "blocked_session_count",
            "longest_xact_age_seconds",
            "hidden_query_count",
            "restricted_activity_count",
            "database_bytes",
            "stats_reset",
            "idle_in_transaction_count",
            "idle_in_xact_oldest_xact_age_seconds",
            "idle_in_xact_longest_idle_seconds",
            "temp_files",
            "temp_bytes",
            "deadlocks",
            "top_blockers",
          ],
          [
            [
              "db",
              1,
              0,
              1,
              0,
              null,
              0,
              0,
              100,
              null,
              0,
              null,
              null,
              0,
              0,
              0,
              "[]",
            ],
          ]
        );
      }
      if (sql.includes("pg_stat_activity") && sql.includes("blocker_pids")) {
        return result(["pid"], []);
      }
      if (sql.includes("extname") || sql.includes("pg_stat_statements")) {
        // capabilities: empty => unavailable
        if (sql.includes("extension_present") || sql.includes("extname")) {
          return result(
            [
              "extension_present",
              "statements_schema",
              "has_total_exec_time",
              "has_total_time",
              "has_mean_exec_time",
              "has_mean_time",
              "has_info_view",
            ],
            []
          );
        }
      }
      if (sql.includes("pg_stat_user_tables")) {
        // large schema fixture: 122 tables worth of rows + 1 extra for truncation
        const rows = Array.from({ length: 122 }, (_, i) => [
          "public",
          `t_${i}`,
          10,
          1,
          null,
          null,
          null,
          null,
          100,
          10,
          110,
          false,
          false,
        ]);
        return result(
          [
            "schemaname",
            "table_name",
            "n_live_tup",
            "n_dead_tup",
            "last_vacuum",
            "last_autovacuum",
            "last_analyze",
            "last_autoanalyze",
            "table_bytes",
            "indexes_bytes",
            "total_bytes",
            "is_partitioned_parent",
            "is_partition_child",
          ],
          rows
        );
      }
      if (sql.includes("pg_stat_user_indexes")) {
        return result(
          [
            "schemaname",
            "table_name",
            "index_name",
            "idx_scan",
            "idx_tup_read",
            "idx_tup_fetch",
            "index_bytes",
          ],
          []
        );
      }
      return result([]);
    });

    const snap = await collectHealthInspectorSnapshot({
      runtimeConnectionId: "c1",
      profileId: "p1",
      engine: "postgres",
      runSql: runSql as any,
    });

    expect(calls.length).toBeLessThanOrEqual(HEALTH_INSPECTOR_MAX_STATEMENTS);
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(snap.overview.status).toBe("ready");
    expect(snap.statements.status).toBe("unavailable");
    expect(snap.tables.data.length).toBe(100);
    expect(snap.tables.truncated).toBe(true);
    // no per-table calls
    expect(calls.filter((c) => c.includes("pg_stat_user_tables")).length).toBe(
      1
    );
  });

  it("degrades only the failing section on partial failures", async () => {
    const runSql = vi.fn(async (_conn: string, sql: string) => {
      if (sql.includes("pg_database_size")) {
        return result(
          [
            "database_name",
            "session_count",
            "active_session_count",
            "idle_session_count",
            "blocked_session_count",
            "longest_xact_age_seconds",
            "hidden_query_count",
            "restricted_activity_count",
            "database_bytes",
            "stats_reset",
            "idle_in_transaction_count",
            "idle_in_xact_oldest_xact_age_seconds",
            "idle_in_xact_longest_idle_seconds",
            "temp_files",
            "temp_bytes",
            "deadlocks",
            "top_blockers",
          ],
          [
            [
              "db",
              1,
              0,
              1,
              0,
              null,
              0,
              0,
              100,
              null,
              0,
              null,
              null,
              0,
              0,
              0,
              "[]",
            ],
          ]
        );
      }
      if (sql.includes("blocker_pids")) {
        throw new Error("permission denied for relation pg_stat_activity");
      }
      if (sql.includes("extname") || sql.includes("extension_present")) {
        return result(
          [
            "extension_present",
            "statements_schema",
            "has_total_exec_time",
            "has_total_time",
            "has_mean_exec_time",
            "has_mean_time",
            "has_info_view",
          ],
          []
        );
      }
      if (sql.includes("pg_stat_user_tables")) {
        return result(
          [
            "schemaname",
            "table_name",
            "n_live_tup",
            "n_dead_tup",
            "last_vacuum",
            "last_autovacuum",
            "last_analyze",
            "last_autoanalyze",
            "table_bytes",
            "indexes_bytes",
            "total_bytes",
            "is_partitioned_parent",
            "is_partition_child",
          ],
          []
        );
      }
      if (sql.includes("pg_stat_user_indexes")) {
        return result(
          [
            "schemaname",
            "table_name",
            "index_name",
            "idx_scan",
            "idx_tup_read",
            "idx_tup_fetch",
            "index_bytes",
          ],
          []
        );
      }
      return result([]);
    });

    const snap = await collectHealthInspectorSnapshot({
      runtimeConnectionId: "c1",
      profileId: "p1",
      engine: "postgres",
      runSql: runSql as any,
    });

    expect(snap.overview.status).toBe("ready");
    expect(snap.sessions.status).toBe("unavailable");
    expect(snap.tables.status).toBe("empty");
  });

  it("stops scheduling after cancel and returns cancelled snapshot", async () => {
    const ac = new AbortController();
    let calls = 0;
    const runSql = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        ac.abort();
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      throw new Error("should not run");
    });

    const snap = await collectHealthInspectorSnapshot({
      runtimeConnectionId: "c1",
      profileId: "p1",
      engine: "postgres",
      signal: ac.signal,
      runSql: runSql as any,
    });

    expect(snap.cancelled).toBe(true);
    expect(calls).toBe(1);
  });
  it("reports each section as it lands and keeps at most two queries in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const optsSeen: any[] = [];
    const runSql = vi.fn(async (_conn: string, sql: string, opts?: any) => {
      optsSeen.push(opts);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (sql.includes("pg_database_size")) {
        return result(["database_name", "session_count"], [["db", 1]]);
      }
      return result([]);
    });
    const progress: Array<{ overview: string; pending: number }> = [];

    const snap = await collectHealthInspectorSnapshot({
      runtimeConnectionId: "c1",
      profileId: "p1",
      engine: "postgres",
      runSql: runSql as any,
      onProgress: (partial) => {
        const sections = [
          partial.sessions,
          partial.statements,
          partial.tables,
          partial.indexes,
        ];
        progress.push({
          overview: partial.overview.status,
          pending: sections.filter((s) => s.status === "loading").length,
        });
      },
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
    // First update clears the previous results; then the overview alone;
    // later updates finish one section each.
    expect(progress[0]).toEqual({ overview: "loading", pending: 4 });
    expect(progress[1]).toEqual({ overview: "ready", pending: 4 });
    expect(progress.map((p) => p.pending)).toEqual([4, 4, 3, 2, 1, 0]);
    expect(snap.finishedAt).not.toBeNull();
    for (const opts of optsSeen) {
      expect(opts).toMatchObject({ readOnly: true, lockTimeoutMs: 1_000 });
      expect(opts.statementTimeoutMs).toBeGreaterThan(0);
    }
  });

  it("stops reporting progress once cancelled", async () => {
    const ac = new AbortController();
    const runSql = vi.fn(async (_conn: string, sql: string) => {
      if (sql.includes("pg_database_size")) {
        return result(["database_name", "session_count"], [["db", 1]]);
      }
      ac.abort();
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    });
    const onProgress = vi.fn();

    const snap = await collectHealthInspectorSnapshot({
      runtimeConnectionId: "c1",
      profileId: "p1",
      engine: "postgres",
      signal: ac.signal,
      runSql: runSql as any,
      onProgress,
    });

    expect(snap.cancelled).toBe(true);
    // Initial all-loading snapshot and the overview; nothing after the cancel.
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("marks size rankings as estimated only beyond the sized candidates", async () => {
    const runSql = vi.fn(async (_conn: string, sql: string) => {
      if (sql.includes("pg_database_size")) {
        return result(["database_name", "session_count"], [["db", 1]]);
      }
      if (sql.includes("pg_stat_user_tables") && sql.includes("total_bytes")) {
        return result(
          ["schemaname", "table_name", "relation_count"],
          [["public", "events", 600]]
        );
      }
      if (sql.includes("pg_stat_user_indexes")) {
        return result(
          ["schemaname", "index_name", "relation_count"],
          [["public", "events_pkey", 500]]
        );
      }
      return result([]);
    });

    const snap = await collectHealthInspectorSnapshot({
      runtimeConnectionId: "c1",
      profileId: "p1",
      engine: "postgres",
      runSql: runSql as any,
    });

    expect(snap.tables.sizeRankingEstimated).toBe(true);
    expect(snap.indexes.sizeRankingEstimated).toBe(false);
  });
});
