import type { DatabaseEngine } from "src/types";
import { lexPostgres, type PgToken } from "./pgLexer";

/**
 * Which statements Explain Analyze accepts (plan
 * .agent/plans/query-analyzer-explain-analyze.md, section 1). Mirrors
 * src-tauri/src/engines/postgres/explain_analyze.rs::classify_for_analyze;
 * both run the shared fixtures in src-tauri/tests/fixtures/analyze_classify.json
 * and the backend's answer wins.
 *
 * A conservative product filter, not a proof of read-only behaviour: the
 * server's read-only transaction is what stops local writes.
 */

export type AnalyzeRefusal =
  | "empty"
  | "unterminated"
  | "multiple_statements"
  | "not_read_only_shape"
  | "parameters"
  | "data_changing"
  | "row_lock";

export type AnalyzeClassification =
  | { ok: true; statement: string }
  | { ok: false; reason: AnalyzeRefusal };

/** Engines whose backend implements Explain Analyze (plan D1). */
export function supportsExplainAnalyze(engine: DatabaseEngine | undefined) {
  return engine === "postgres";
}

/**
 * What the Pro "Explain" button does with `sql`: measure it when Explain
 * Analyze accepts it, otherwise show the estimated plan (which never runs it).
 */
export function explainModeFor(sql: string): "analyze" | "estimate" {
  return classifyForAnalyze(sql).ok ? "analyze" : "estimate";
}

const LEADING = new Set(["SELECT", "WITH", "VALUES", "TABLE"]);

/** Refused anywhere outside strings/comments/quoted identifiers. Not `END`
 * (it closes every CASE). */
const FORBIDDEN = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "INTO",
  "COPY",
  "CALL",
  "DO",
  "EXECUTE",
  "PREPARE",
  "DEALLOCATE",
  "LOCK",
  "NOTIFY",
  "LISTEN",
  "UNLISTEN",
  "SET",
  "RESET",
  "DISCARD",
  "VACUUM",
  "ANALYZE",
  "CLUSTER",
  "REINDEX",
  "REFRESH",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COMMENT",
  "SECURITY",
  "BEGIN",
  "START",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "ABORT",
  "EXPLAIN",
]);

const ROW_LOCK_NEXT = new Set(["UPDATE", "SHARE", "NO", "KEY"]);

export function classifyForAnalyze(sql: string): AnalyzeClassification {
  const { tokens, unterminated } = lexPostgres(sql);
  if (unterminated) return { ok: false, reason: "unterminated" };

  const statements: { start: number; end: number; body: PgToken[] }[] = [];
  let first: PgToken | null = null;
  let last: PgToken | null = null;
  let body: PgToken[] = [];
  const flush = () => {
    if (first && last) {
      statements.push({ start: first.start, end: last.end, body });
    }
    first = null;
    last = null;
    body = [];
  };
  for (const token of tokens) {
    if (token.kind === "semicolon") {
      flush();
    } else if (token.kind === "comment") {
      if (!first) first = token;
    } else {
      if (!first) first = token;
      last = token;
      body.push(token);
    }
  }
  flush();

  if (statements.length === 0) return { ok: false, reason: "empty" };
  if (statements.length > 1) {
    return { ok: false, reason: "multiple_statements" };
  }
  const statement = statements[0]!;
  const word = (token: PgToken) =>
    token.kind === "word"
      ? sql.slice(token.start, token.end).toUpperCase()
      : "";
  const words = statement.body.map(word);
  if (!LEADING.has(words[0] ?? "")) {
    return { ok: false, reason: "not_read_only_shape" };
  }
  if (statement.body.some((token) => token.kind === "param")) {
    return { ok: false, reason: "parameters" };
  }
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "FOR" && ROW_LOCK_NEXT.has(words[i + 1] ?? "")) {
      return { ok: false, reason: "row_lock" };
    }
  }
  if (words.some((w) => FORBIDDEN.has(w))) {
    return { ok: false, reason: "data_changing" };
  }
  return { ok: true, statement: sql.slice(statement.start, statement.end) };
}
