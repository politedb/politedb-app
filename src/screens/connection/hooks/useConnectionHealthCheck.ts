import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { runtimeWorkIsCurrent } from "src/lib/runtimeConnection";
import { connectionVersion } from "src/lib/tauri";
import { runSqlQuery } from "src/lib/tauri/query";
import type { DatabaseEngine } from "src/types";

export type HealthStatus = "unknown" | "healthy" | "degraded" | "down";

function pingSql(engine?: DatabaseEngine): string | null {
  if (!engine) return null;
  if (engine === "mongo" || engine === "redis" || engine === "cassandra") {
    return null;
  }
  if (engine === "oracle") return "SELECT 1 FROM dual";
  return "SELECT 1";
}

export function useConnectionHealthCheck(args: {
  runtimeConnectionId?: string;
  engine?: DatabaseEngine;
  loadError?: string | null;
}) {
  const { runtimeConnectionId, engine, loadError } = args;
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<HealthStatus>(
    loadError ? "degraded" : runtimeConnectionId ? "unknown" : "down"
  );
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkSeqRef = useRef(0);

  const runCheck = useCallback(async () => {
    if (!runtimeConnectionId) {
      setStatus("down");
      setLatencyMs(null);
      setError("No active runtime connection.");
      return;
    }

    // A ping of an older or refused connection never reports health (R5).
    const seq = ++checkSeqRef.current;
    const current = runtimeWorkIsCurrent(runtimeConnectionId);
    const mine = () => checkSeqRef.current === seq && current();
    setChecking(true);
    setError(null);
    const started = performance.now();
    try {
      const sql = pingSql(engine);
      if (sql) {
        await runSqlQuery(runtimeConnectionId, sql, { timeoutMs: 10_000 });
      } else {
        await connectionVersion(runtimeConnectionId);
      }
      if (!mine()) return;
      const elapsed = Math.max(1, Math.round(performance.now() - started));
      setLatencyMs(elapsed);
      setCheckedAt(Date.now());
      setStatus(elapsed > 1500 ? "degraded" : "healthy");
    } catch (err) {
      if (!mine()) return;
      setLatencyMs(null);
      setCheckedAt(Date.now());
      setStatus("down");
      setError(err instanceof Error ? err.message : "Health check failed.");
    } finally {
      if (checkSeqRef.current === seq) setChecking(false);
    }
  }, [runtimeConnectionId, engine]);

  useEffect(() => {
    setLatencyMs(null);
    setCheckedAt(null);
    setError(null);
    setStatus(
      loadError ? "degraded" : runtimeConnectionId ? "unknown" : "down"
    );
    if (!runtimeConnectionId) return;
    void runCheck();
  }, [runtimeConnectionId, engine, loadError, runCheck]);

  return { checking, status, latencyMs, checkedAt, error, runCheck };
}
