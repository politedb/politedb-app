import { describe, expect, it } from "vitest";
import {
  HEALTH_INSPECTOR_FETCH_LIMIT,
  HEALTH_INSPECTOR_LIST_LIMIT,
  HEALTH_INSPECTOR_QUERY_TEXT_CAP,
  healthInspectorCapabilitiesSql,
  healthInspectorIndexesSql,
  healthInspectorOverviewSql,
  healthInspectorSessionsSql,
  healthInspectorStatementsInfoSql,
  healthInspectorStatementsSql,
  healthInspectorTablesSql,
} from "./health-inspector";

describe("healthInspector SQL builders", () => {
  it("uses catalog/statistics sources only and caps list fetches", () => {
    const sessions = healthInspectorSessionsSql();
    expect(sessions).toContain("pg_catalog.pg_stat_activity");
    expect(sessions).toContain(`LIMIT ${HEALTH_INSPECTOR_FETCH_LIMIT}`);
    expect(sessions).toContain(
      `LEFT(a.query, ${HEALTH_INSPECTOR_QUERY_TEXT_CAP})`
    );
    expect(sessions).toContain("current_database()");
    expect(sessions).not.toMatch(/SELECT \* FROM (?!pg_)/i);

    const tables = healthInspectorTablesSql();
    expect(tables).toContain("pg_catalog.pg_stat_user_tables");
    expect(tables).toContain("relispartition");
    expect(tables).toContain(`LIMIT ${HEALTH_INSPECTOR_FETCH_LIMIT}`);
    expect(HEALTH_INSPECTOR_FETCH_LIMIT).toBe(HEALTH_INSPECTOR_LIST_LIMIT + 1);

    const indexes = healthInspectorIndexesSql();
    expect(indexes).toContain("pg_catalog.pg_stat_user_indexes");
    expect(indexes).toContain("idx_scan");
  });

  it("overview aggregates sessions and database size without table scans", () => {
    const sql = healthInspectorOverviewSql();
    expect(sql).toContain("pg_database_size");
    expect(sql).toContain("pg_blocking_pids");
    expect(sql).toContain("longest_xact_age_seconds");
    expect(sql).toContain("idle_in_transaction_count");
    expect(sql).toContain("idle_in_xact_oldest_xact_age_seconds");
    expect(sql).toContain("idle_in_xact_longest_idle_seconds");
    expect(sql).toContain("idle in transaction%");
    expect(sql).toContain("temp_files");
    expect(sql).toContain("temp_bytes");
    expect(sql).toContain("deadlocks");
    expect(sql).toContain("top_blockers");
    expect(sql).toContain("LIMIT 5");
    expect(sql).toContain("pg_backend_pid()");
    expect(sql).toContain("WITH act AS");
    expect(sql).not.toContain("pg_stat_user_tables");
  });

  it("adapts statement columns and quotes schema identifiers", () => {
    const caps = healthInspectorCapabilitiesSql();
    expect(caps).toContain("pg_stat_statements");
    expect(caps).toContain("total_exec_time");
    expect(caps).toContain("total_time");

    const statements = healthInspectorStatementsSql({
      schema: 'ext"schema',
      totalTimeColumn: "total_exec_time",
      meanTimeColumn: "mean_exec_time",
      hasInfoView: true,
    });
    expect(statements).toContain('"ext""schema".pg_stat_statements');
    expect(statements).toContain("total_exec_time");
    expect(statements).toContain(
      `LEFT(s.query, ${HEALTH_INSPECTOR_QUERY_TEXT_CAP})`
    );

    const info = healthInspectorStatementsInfoSql("public");
    expect(info).toContain('"public".pg_stat_statements_info');
  });
});

it("detects restricted activity via insufficient privilege marker", () => {
  const overview = healthInspectorOverviewSql();
  expect(overview).toContain("<insufficient privilege>");
  expect(overview).toContain("restricted_activity_count");
  expect(overview).toContain("hidden_query_count");

  const sessions = healthInspectorSessionsSql();
  expect(sessions).toContain("<insufficient privilege>");
  expect(sessions).toContain("query_hidden");
});

it("includes partition leaves with labels rather than omitting them", () => {
  const tables = healthInspectorTablesSql();
  expect(tables).toContain("relispartition");
  expect(tables).toContain("is_partition_child");
  expect(tables).not.toContain("WHERE NOT COALESCE(c.relispartition");
  expect(tables).toContain(
    "COALESCE(c.relispartition, false) AS is_partition_child"
  );
});
