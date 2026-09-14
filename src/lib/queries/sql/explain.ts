import type { DatabaseEngine } from "src/types";

export function buildExplainSql(
  engine: DatabaseEngine,
  sql: string
):
  | { statements: string[]; error?: undefined }
  | { statements?: undefined; error: string } {
  const statement = sql.trim().replace(/;+$/g, "").trim();
  if (!statement) return { error: "SQL is empty." };

  switch (engine) {
    case "postgres":
      return { statements: [`EXPLAIN (FORMAT JSON) ${statement}`] };
    case "mysql":
      return { statements: [`EXPLAIN FORMAT=JSON ${statement}`] };
    case "mariadb":
      return { statements: [`EXPLAIN FORMAT=JSON ${statement}`] };
    case "duckdb":
      return { statements: [`EXPLAIN ${statement}`] };
    case "clickhouse":
      return { statements: [`EXPLAIN json=1 ${statement}`] };
    case "snowflake":
      return { statements: [`EXPLAIN USING JSON ${statement}`] };
    case "sqlite":
    case "d1":
    case "turso":
      return { statements: [`EXPLAIN QUERY PLAN ${statement}`] };
    case "sqlserver":
      return {
        statements: [
          `SET SHOWPLAN_ALL ON;\n${statement};\nSET SHOWPLAN_ALL OFF;`,
        ],
      };
    case "oracle":
      return {
        statements: [
          `EXPLAIN PLAN FOR ${statement}`,
          "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())",
        ],
      };
    case "cassandra":
      return {
        error:
          "Cassandra CQL has no query plan / EXPLAIN in this editor. Tracing is not wired yet.",
      };
    case "mongo":
      return {
        error:
          "MongoDB has no SQL EXPLAIN in this editor. Collection explain is not wired yet.",
      };
    case "redis":
      return { error: "Redis commands have no query plan / EXPLAIN." };
    case "google_sheets":
      return { error: "Google Sheets has no query plan / EXPLAIN." };
    default:
      return { error: "Explain is not supported for this engine yet." };
  }
}
