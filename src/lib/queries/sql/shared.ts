import type { DatabaseEngine } from "src/types";
import { quoteIdentifier, sqlStringLiteral } from "src/utils/sqlDialect";

export function isMySqlLike(engine?: DatabaseEngine) {
  return engine === "mysql" || engine === "mariadb";
}

/** SQLite/D1 only — DuckDB uses information_schema / duckdb_* metadata instead. */
export function isSqlitePragmaEngine(engine?: DatabaseEngine) {
  return engine === "sqlite" || engine === "d1" || engine === "turso";
}

export function qIdent(ident: string, engine?: DatabaseEngine) {
  return quoteIdentifier(ident, engine);
}

export function qLiteral(v: string, engine?: DatabaseEngine) {
  return sqlStringLiteral(v, engine);
}

export function regexEscape(s: string) {
  return s.replace(/\s*=\s*/g, "=").replace(/\s+/g, " ");
}
