import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
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

type WindowState = {
  slots: SqlResultSlot[] | null;
  activeIndex: number;
};

export function useSqlRunner(args: {
  activeSqlWindowId?: string;
  runtimeConnectionId?: string;
  onRunSql: RunSqlFn;
}) {
  const { activeSqlWindowId, runtimeConnectionId, onRunSql } = args;

  // Persist results per window id (so switching tabs keeps results)
  const stateByWindowIdRef = useRef<Map<string, WindowState>>(new Map());

  // One run id per window, so rerun in window A doesn't cancel window B
  const runIdByWindowRef = useRef<Map<string, number>>(new Map());

  const getSaved = useCallback((): WindowState => {
    if (!activeSqlWindowId) return { slots: null, activeIndex: 0 };
    return (
      stateByWindowIdRef.current.get(activeSqlWindowId) ?? {
        slots: null,
        activeIndex: 0,
      }
    );
  }, [activeSqlWindowId]);

  // Init from current active window state (first render)
  const initial = useMemo(() => getSaved(), [getSaved]);

  const [sqlSlots, setSqlSlots] = useState<SqlResultSlot[] | null>(
    initial.slots
  );
  const [activeResultIndex, setActiveResultIndex] = useState<number>(
    initial.activeIndex
  );

  // Restore state when switching SQL tabs/windows
  useEffect(() => {
    if (!activeSqlWindowId) return;

    const saved = stateByWindowIdRef.current.get(activeSqlWindowId);
    setSqlSlots(saved?.slots ?? null);
    setActiveResultIndex(saved?.activeIndex ?? 0);
  }, [activeSqlWindowId]);

  // Persist whenever state changes
  useEffect(() => {
    if (!activeSqlWindowId) return;

    stateByWindowIdRef.current.set(activeSqlWindowId, {
      slots: sqlSlots,
      activeIndex: activeResultIndex,
    });
  }, [activeSqlWindowId, sqlSlots, activeResultIndex]);

  const bumpRunId = useCallback((windowId: string) => {
    const next = (runIdByWindowRef.current.get(windowId) ?? 0) + 1;
    runIdByWindowRef.current.set(windowId, next);
    return next;
  }, []);

  const currentRunId = useCallback((windowId: string) => {
    return runIdByWindowRef.current.get(windowId) ?? 0;
  }, []);

  const startRun = useCallback(
    async (payload: { windowId: string; sql: string }) => {
      const winId = payload.windowId;

      if (!runtimeConnectionId) return;

      const v = validateSqlClient(payload.sql);
      if (!v.ok) {
        const slots: SqlResultSlot[] = [
          {
            index: 0,
            sql: payload.sql,
            status: "error",
            error: v.message,
            finishedAt: Date.now(),
          },
        ];

        // update local state
        setSqlSlots(slots);
        setActiveResultIndex(0);

        // update per-window cache immediately
        stateByWindowIdRef.current.set(winId, { slots, activeIndex: 0 });

        // cancel any inflight run for this window logically
        bumpRunId(winId);
        return;
      }

      const list = v.statements;
      const runId = bumpRunId(winId);

      const initialSlots: SqlResultSlot[] = list.map((sql, i) => ({
        index: i,
        sql,
        status: "queued" as const,
      }));

      setSqlSlots(initialSlots);
      setActiveResultIndex(0);
      stateByWindowIdRef.current.set(winId, {
        slots: initialSlots,
        activeIndex: 0,
      });

      const setSlot = (i: number, patch: Partial<SqlResultSlot>) => {
        setSqlSlots((prev) => {
          if (!prev || !prev[i]) return prev;
          const next = prev.slice();
          next[i] = { ...next[i], ...patch };
          return next;
        });

        // also patch cached state (avoid relying on effect timing)
        const cached = stateByWindowIdRef.current.get(winId);
        if (!cached?.slots || !cached.slots[i]) return;
        const nextSlots = cached.slots.slice();
        nextSlots[i] = { ...nextSlots[i], ...patch } as SqlResultSlot;
        stateByWindowIdRef.current.set(winId, {
          slots: nextSlots,
          activeIndex: stateByWindowIdRef.current.get(winId)?.activeIndex ?? 0,
        });
      };

      const setActive = (idx: number) => {
        setActiveResultIndex(idx);
        const cached = stateByWindowIdRef.current.get(winId);
        stateByWindowIdRef.current.set(winId, {
          slots: cached?.slots ?? null,
          activeIndex: idx,
        });
      };

      for (let i = 0; i < list.length; i++) {
        // cancelled / superseded for this window
        if (currentRunId(winId) !== runId) return;

        setSlot(i, { status: "running", startedAt: Date.now() });
        setActive(i);

        try {
          await validateSqlQueryBE(runtimeConnectionId, list[i], {
            timeoutMs: 20_000,
            statementTimeoutMs: 15_000,
          });

          if (currentRunId(winId) !== runId) return;

          const result = await onRunSql({
            windowId: winId,
            connectionId: runtimeConnectionId,
            sql: list[i],
          });

          if (currentRunId(winId) !== runId) return;

          setSlot(i, {
            status: "done",
            result,
            finishedAt: Date.now(),
          });
        } catch (err) {
          if (currentRunId(winId) !== runId) return;

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
    [bumpRunId, currentRunId, onRunSql, runtimeConnectionId]
  );

  // Reset only current active window's results
  const reset = useCallback(() => {
    if (!activeSqlWindowId) return;

    const winId = activeSqlWindowId;

    setSqlSlots(null);
    setActiveResultIndex(0);

    stateByWindowIdRef.current.set(winId, { slots: null, activeIndex: 0 });
    bumpRunId(winId);
  }, [activeSqlWindowId, bumpRunId]);

  // Optional: call when window/tab is closed to free memory
  const clearWindow = useCallback((windowId: string) => {
    stateByWindowIdRef.current.delete(windowId);
    runIdByWindowRef.current.delete(windowId);
  }, []);

  return {
    sqlSlots,
    activeResultIndex,
    setActiveResultIndex,
    startRun,
    reset,
    clearWindow,
  };
}
