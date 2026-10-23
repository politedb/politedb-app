import type { DatabaseEngine } from "src/types";
import { splitSqlStatements } from "src/components/editor/splitSqlStatements";
import {
  lexPostgres,
  pgLeadingKeyword,
  pgStatements,
} from "src/lib/sql/pgLexer";

/** Leading keyword after whitespace and (nested) comments, upper-cased. */
export function leadingSqlKeyword(sql: string): string {
  return pgLeadingKeyword(sql);
}

/**
 * Whether `sql` asks for a plan itself: EXPLAIN on every engine, plus
 * MariaDB's `ANALYZE FORMAT=JSON …` (its measured plan; plain
 * `ANALYZE TABLE` is not).
 */
export function isPlanStatement(engine: DatabaseEngine, sql: string): boolean {
  const words = lexPostgres(sql)
    .tokens.filter((token) => token.kind !== "comment")
    .slice(0, 2)
    .map((token) => sql.slice(token.start, token.end).toUpperCase());
  if (words[0] === "EXPLAIN") return true;
  return (
    engine === "mariadb" && words[0] === "ANALYZE" && words[1] === "FORMAT"
  );
}

/**
 * PostgreSQL positional parameters ($1, $2, ...) outside strings, quoted
 * identifiers, comments and dollar-quoted bodies.
 */
export function hasPositionalParameters(sql: string): boolean {
  return lexPostgres(sql).tokens.some((token) => token.kind === "param");
}

/** Executable statements, ignoring comment-only fragments. */
function executableStatements(
  engine: DatabaseEngine,
  sql: string
): { statements: string[]; unreadable: boolean } {
  if (engine === "postgres") {
    const { statements, unterminated } = pgStatements(sql);
    return { statements, unreadable: unterminated };
  }
  const statements = splitSqlStatements(sql)
    .map((part) => part.text.replace(/;+\s*$/g, "").trim())
    .filter((text) =>
      lexPostgres(text).tokens.some((token) => token.kind !== "comment")
    );
  return { statements, unreadable: false };
}

export function buildExplainSql(
  engine: DatabaseEngine,
  sql: string
):
  | { statements: string[]; source?: string; error?: undefined }
  | { statements?: undefined; source?: undefined; error: string } {
  const { statements, unreadable } = executableStatements(engine, sql);
  if (unreadable) {
    return {
      error:
        "Could not read the statement: a quote, dollar quote or comment is not closed.",
    };
  }
  if (!statements.length) return { error: "SQL is empty." };
  if (statements.length > 1) {
    return {
      error:
        "Explain works on one statement at a time. Put the cursor in a single statement or select just one.",
    };
  }
  const statement = statements[0]!;
  if (isPlanStatement(engine, statement)) {
    return {
      error:
        "This is already an EXPLAIN statement. Use Run to execute it; a JSON plan result opens in the Query Analyzer.",
    };
  }
  if (engine === "postgres" && hasPositionalParameters(statement)) {
    return {
      error:
        "Statements with parameters ($1, $2, ...) can't be explained. Replace them with sample values first.",
    };
  }

  switch (engine) {
    case "postgres":
      return {
        statements: [`EXPLAIN (FORMAT JSON) ${statement}`],
        source: statement,
      };
    case "mysql":
      return {
        statements: [`EXPLAIN FORMAT=JSON ${statement}`],
        source: statement,
      };
    case "mariadb":
      return {
        statements: [`EXPLAIN FORMAT=JSON ${statement}`],
        source: statement,
      };
    case "duckdb":
      // The bundled DuckDB (1.5) returns the plan as JSON in explain_value.
      return {
        statements: [`EXPLAIN (FORMAT JSON) ${statement}`],
        source: statement,
      };
    case "clickhouse":
      return { statements: [`EXPLAIN json=1 ${statement}`], source: statement };
    case "snowflake":
      return {
        statements: [`EXPLAIN USING JSON ${statement}`],
        source: statement,
      };
    case "sqlite":
    case "d1":
    case "turso":
      return {
        statements: [`EXPLAIN QUERY PLAN ${statement}`],
        source: statement,
      };
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
