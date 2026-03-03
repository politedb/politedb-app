import { operationBus } from "src/lib/tauri/operationBus";
import { operationExecute, operationCancel } from "src/lib/tauri";
import { splitSqlStatements } from "src/components/editor/splitSqlStatements";

type ValidateSqlOptions = {
  timeoutMs?: number;
  statementTimeoutMs?: number;
};

export function normalizeSqlError(err: any): string {
  const raw = err?.message ?? (typeof err === "string" ? err : "");

  if (!raw) return "Unknown SQL error.";

  // ===== Syntax / prepare =====
  if (raw.includes("PREPARE_FAILED")) {
    return "SQL syntax error. Please check your query.";
  }

  // ===== Timeout =====
  if (
    raw.includes("statement timeout") ||
    raw.includes("QUERY_TIMEOUT") ||
    raw.includes("SQL_QUERY_TIMEOUT")
  ) {
    return "Query timed out. Try adding LIMIT or simplifying the query.";
  }

  // ===== Permission =====
  if (raw.includes("permission denied")) {
    return "Permission denied for this operation.";
  }

  // ===== Cancel =====
  if (raw.includes("cancel")) {
    return "Query was cancelled.";
  }

  // ===== Connection =====
  if (raw.includes("CONNECTION_NOT_FOUND")) {
    return "Database connection was lost.";
  }

  // ===== Fallback =====
  return raw.replace(/^[A-Z_]+:\s*/, "");
}

export function unwrapErrorMessage(input: unknown): string {
  let cur: unknown = input;

  // unwrap up to 3 layers (handles double-encoded JSON strings)
  for (let i = 0; i < 3; i++) {
    if (typeof cur === "string") {
      const s = cur.trim();

      // try parse json string
      if (s.startsWith("{") || s.startsWith("[")) {
        try {
          cur = JSON.parse(s);
          continue;
        } catch {
          return cur as string;
        }
      }

      return cur;
    }

    if (cur && typeof cur === "object") {
      const any = cur as any;
      if (typeof any.error === "string") return any.error;
      if (typeof any.message === "string") return any.message;

      try {
        return JSON.stringify(any);
      } catch {
        return String(any);
      }
    }

    return String(cur);
  }

  return String(cur);
}

function stripComments(sql: string) {
  // very light: remove -- ... and /* ... */ for heuristic only
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function looksLikeMultipleStatementsWithoutSemicolons(sql: string) {
  const s = stripComments(sql).trim();
  if (!s) return false;

  // if user already has ';', don't warn here
  if (s.includes(";")) return false;

  const lower = s.toLowerCase();

  // count statement starters at line start (best heuristic)
  const starters = lower.match(
    /^\s*(select|with|insert|update|delete|create|alter|drop|truncate)\b/gm
  );

  return (starters?.length ?? 0) >= 2;
}

export function validateSqlClient(sql: string) {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false as const, message: "SQL is empty." };

  const parts = splitSqlStatements(trimmed) as any;
  const stmts =
    typeof parts?.[0] === "string"
      ? (parts as string[])
      : (parts as { text: string }[]).map((p) => p.text);

  const list = (stmts.length ? stmts : [trimmed])
    .map((s) => s.trim())
    .filter(Boolean);

  if (!list.length) {
    return { ok: false as const, message: "No SQL statement found." };
  }

  // ✅ key addition: if splitter returns 1 statement but looks like multiple => missing ';'
  if (
    list.length === 1 &&
    looksLikeMultipleStatementsWithoutSemicolons(trimmed)
  ) {
    return {
      ok: false as const,
      message: "Multiple SQL statements must be separated by semicolons (;).",
    };
  }

  return { ok: true as const, statements: list };
}

export function toErrorMessage(err: any) {
  if (typeof err?.error === "string") return err.error;

  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err?.message === "string") return err.message;

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function validateSqlQueryBE(
  connection_id: string,
  sql: string,
  opts?: ValidateSqlOptions
): Promise<void> {
  const opId = await operationExecute({
    connection_id,
    kind: "sql_query",
    sql: {
      sql,
      validate_only: true,
      // keep it short; this is just validation
      statement_timeout_ms: opts?.statementTimeoutMs ?? 15_000,
      batch_size: 1,
      max_rows: 1,
    },
  });

  const timeoutMs = opts?.timeoutMs ?? 20_000;

  return new Promise<void>(async (resolve, reject) => {
    let finished = false;
    let unsub: (() => void) | null = null;
    let timerId: number | null = null;

    const cleanup = () => {
      try {
        unsub?.();
      } catch {}
      unsub = null;
      if (timerId) window.clearTimeout(timerId);
      timerId = null;
    };

    const ok = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };

    const fail = (err: any) => {
      if (finished) return;
      finished = true;
      cleanup();

      const msg = toErrorMessage(err);
      reject(new Error(msg));
    };

    if (timeoutMs > 0) {
      timerId = window.setTimeout(async () => {
        if (finished) return;
        finished = true;
        cleanup();
        try {
          await operationCancel(opId);
        } catch {}
        reject(new Error("SQL_VALIDATE_TIMEOUT"));
      }, timeoutMs);
    }

    try {
      unsub = await operationBus.subscribe(opId, {
        onDone: () => ok(),
        onError: (err) => fail(err),
      });
    } catch (e) {
      fail(e);
    }
  });
}
