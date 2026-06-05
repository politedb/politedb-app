import type { DatabaseEngine } from "src/types";

const EXPLAIN_PREFIX_BY_ENGINE: Partial<Record<DatabaseEngine, string>> = {
  postgres: "EXPLAIN",
  mysql: "EXPLAIN",
  mariadb: "EXPLAIN",
  duckdb: "EXPLAIN",
  clickhouse: "EXPLAIN",
  snowflake: "EXPLAIN",
  sqlite: "EXPLAIN QUERY PLAN",
  d1: "EXPLAIN QUERY PLAN",
  turso: "EXPLAIN QUERY PLAN",
};

export function buildExplainSql(
  engine: DatabaseEngine,
  sql: string
): { sql: string; error?: undefined } | { sql?: undefined; error: string } {
  const statement = sql.trim().replace(/;+$/g, "").trim();
  if (!statement) return { error: "SQL is empty." };

  const prefix = EXPLAIN_PREFIX_BY_ENGINE[engine];
  if (!prefix) {
    return { error: "Explain is not supported for this engine yet." };
  }

  return { sql: `${prefix} ${statement}` };
}
