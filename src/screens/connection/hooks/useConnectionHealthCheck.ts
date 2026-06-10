import { useCallback, useEffect, useState } from "preact/hooks";
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

  const runCheck = useCallback(async () => {
    if (!runtimeConnectionId) {
      setStatus("down");
      setLatencyMs(null);
      setError("No active runtime connection.");
      return;
    }

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
      const elapsed = Math.max(1, Math.round(performance.now() - started));
      setLatencyMs(elapsed);
      setCheckedAt(Date.now());
      setStatus(elapsed > 1500 ? "degraded" : "healthy");
    } catch (err) {
      setLatencyMs(null);
      setCheckedAt(Date.now());
      setStatus("down");
      setError(err instanceof Error ? err.message : "Health check failed.");
    } finally {
      setChecking(false);
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
