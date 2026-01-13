import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { QueryResult, SqlResultSlot } from "src/lib/tauri";
import {
  unwrapErrorMessage,
  validateSqlClient,
  validateSqlQueryBE,
} from "src/utils/queryValidate";

function formatQueryError(err: unknown, index: number) {
  const msg = unwrapErrorMessage(err);
  return `Query ${index + 1} ERROR:\n${msg}`;
}

type RunSqlFn = (args: {
  windowId: string;
  connectionId: string;
  sql: string;
}) => Promise<QueryResult>;

export function useSqlRunner(args: {
  activeSqlWindowId?: string;
  runtimeConnectionId: string | null;
  onRunSql: RunSqlFn;
}) {
  const { activeSqlWindowId, runtimeConnectionId, onRunSql } = args;

  const [sqlSlots, setSqlSlots] = useState<SqlResultSlot[] | null>(null);
  const [activeResultIndex, setActiveResultIndex] = useState(0);

  // Used to cancel previous runs logically (switch window / rerun)
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!activeSqlWindowId) return;
    setSqlSlots(null);
    setActiveResultIndex(0);
    runIdRef.current++;
  }, [activeSqlWindowId]);

  const startRun = useCallback(
    async (payload: { windowId: string; sql: string }) => {
      if (!runtimeConnectionId) return;

      const v = validateSqlClient(payload.sql);
      if (!v.ok) {
        setSqlSlots([
          {
            index: 0,
            sql: payload.sql,
            status: "error",
            error: v.message,
            finishedAt: Date.now(),
          },
        ]);
        setActiveResultIndex(0);
        return;
      }

      const list = v.statements;
      const runId = ++runIdRef.current;

      setSqlSlots(
        list.map((sql, i) => ({
          index: i,
          sql,
          status: "queued" as const,
        }))
      );
      setActiveResultIndex(0);

      const setSlot = (i: number, patch: Partial<SqlResultSlot>) => {
        setSqlSlots((prev) => {
          if (!prev || !prev[i]) return prev;
          const next = prev.slice();
          next[i] = { ...next[i], ...patch };
          return next;
        });
      };

      for (let i = 0; i < list.length; i++) {
        if (runIdRef.current !== runId) return;

        setSlot(i, { status: "running", startedAt: Date.now() });
        setActiveResultIndex(i);

        try {
          // BE validation (no-execute)
          await validateSqlQueryBE(runtimeConnectionId, list[i], {
            timeoutMs: 20_000,
            statementTimeoutMs: 15_000,
          });

          if (runIdRef.current !== runId) return;

          const result = await onRunSql({
            windowId: payload.windowId,
            connectionId: runtimeConnectionId,
            sql: list[i],
          });

          if (runIdRef.current !== runId) return;

          setSlot(i, {
            status: "done",
            result,
            finishedAt: Date.now(),
          });
        } catch (err) {
          if (runIdRef.current !== runId) return;

          setSlot(i, {
            status: "error",
            error: formatQueryError(err, i),
            finishedAt: Date.now(),
          });

          // stop-on-error
          break;
        }
      }
    },
    [onRunSql, runtimeConnectionId]
  );

  const reset = useCallback(() => {
    setSqlSlots(null);
    setActiveResultIndex(0);
    runIdRef.current++;
  }, []);

  return {
    sqlSlots,
    setSqlSlots, // optional escape hatch
    activeResultIndex,
    setActiveResultIndex,
    startRun,
    reset,
  };
}
