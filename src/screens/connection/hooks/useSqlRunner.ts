import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { SqlResultSlot } from "src/lib/tauri";
import {
  unwrapErrorMessage,
  validateSqlClient,
  validateSqlQueryBE,
} from "src/lib/tauri/queryValidate";
import { RunSqlReturn } from "./useSqlHistoryRunner";
import {
  ensureSqlStreamStarted,
  clearSqlStream,
} from "src/screens/connection/hooks/useSqlStreamResult";

function formatQueryError(err: unknown, index: number) {
  const msg = unwrapErrorMessage(err);
  return `Query ${index + 1} ERROR:\n${msg}`;
}

type RunSqlFn = (args: {
  windowId: string;
  connectionId: string;
  sql: string;
}) => Promise<RunSqlReturn>;

type WindowState = {
  slots: SqlResultSlot[] | null;
  activeIndex: number;
};

const CONCURRENCY = 2;

// Gate settings
const RUN_THROTTLE_MS = 400;

export function useSqlRunner(args: {
  activeSqlWindowId?: string;
  runtimeConnectionId?: string;
  onRunSql: RunSqlFn;
  stopOnError?: boolean;
}) {
  const {
    activeSqlWindowId,
    runtimeConnectionId,
    onRunSql,
    stopOnError = false,
  } = args;

  const stateByWindowIdRef = useRef<Map<string, WindowState>>(new Map());
  const runIdByWindowRef = useRef<Map<string, number>>(new Map());

  // ✅ Gate: per-window in-flight flag + throttle
  const inflightByWindowRef = useRef<Map<string, boolean>>(new Map());
  const lastRunAtByWindowRef = useRef<Map<string, number>>(new Map());

  const getSaved = useCallback((): WindowState => {
    if (!activeSqlWindowId) return { slots: null, activeIndex: 0 };
    return (
      stateByWindowIdRef.current.get(activeSqlWindowId) ?? {
        slots: null,
        activeIndex: 0,
      }
    );
  }, [activeSqlWindowId]);

  const initial = useMemo(() => getSaved(), [getSaved]);

  const [sqlSlots, setSqlSlots] = useState<SqlResultSlot[] | null>(
    initial.slots
  );
  const [activeResultIndex, setActiveResultIndex] = useState<number>(
    initial.activeIndex
  );

  useEffect(() => {
    if (!activeSqlWindowId) return;
    const saved = stateByWindowIdRef.current.get(activeSqlWindowId);
    setSqlSlots(saved?.slots ?? null);
    setActiveResultIndex(saved?.activeIndex ?? 0);
  }, [activeSqlWindowId]);

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

      // ✅ Gate 1: throttle
      const now = Date.now();
      const lastAt = lastRunAtByWindowRef.current.get(winId) ?? 0;
      if (now - lastAt < RUN_THROTTLE_MS) return;
      lastRunAtByWindowRef.current.set(winId, now);

      // ✅ Gate 2: single in-flight run per window
      if (inflightByWindowRef.current.get(winId)) return;
      inflightByWindowRef.current.set(winId, true);

      try {
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
          setSqlSlots(slots);
          setActiveResultIndex(0);
          stateByWindowIdRef.current.set(winId, { slots, activeIndex: 0 });
          bumpRunId(winId);
          return;
        }

        const list = v.statements;
        const runId = bumpRunId(winId);

        // clear previous stream caches for this window
        const prev = stateByWindowIdRef.current.get(winId)?.slots;
        for (const s of prev ?? []) {
          if (s.mode === "stream" && s.opId) clearSqlStream(s.opId);
        }

        const initialSlots: SqlResultSlot[] = list.map((sql, i) => ({
          index: i,
          sql,
          status: "queued",
        }));

        setSqlSlots(initialSlots);
        setActiveResultIndex(0);
        stateByWindowIdRef.current.set(winId, {
          slots: initialSlots,
          activeIndex: 0,
        });

        const setSlot = (i: number, patch: Partial<SqlResultSlot>) => {
          setSqlSlots((prevSlots) => {
            if (!prevSlots || !prevSlots[i]) return prevSlots;
            const next = prevSlots.slice();
            next[i] = { ...next[i], ...patch };
            return next;
          });

          const cached = stateByWindowIdRef.current.get(winId);
          if (!cached?.slots || !cached.slots[i]) return;
          const nextSlots = cached.slots.slice();
          nextSlots[i] = { ...nextSlots[i], ...patch } as SqlResultSlot;
          stateByWindowIdRef.current.set(winId, {
            slots: nextSlots,
            activeIndex: cached.activeIndex,
          });
        };

        const runOne = async (i: number) => {
          if (currentRunId(winId) !== runId) return;

          setSlot(i, { status: "running", startedAt: Date.now() });

          try {
            await validateSqlQueryBE(runtimeConnectionId, list[i], {
              timeoutMs: 20_000,
              statementTimeoutMs: 15_000,
            });

            if (currentRunId(winId) !== runId) return;

            const response = await onRunSql({
              windowId: winId,
              connectionId: runtimeConnectionId,
              sql: list[i],
            });

            if (currentRunId(winId) !== runId) return;

            if (response.mode === "direct") {
              setSlot(i, {
                status: "done",
                mode: "direct",
                result: response.result,
                finishedAt: Date.now(),
              });
            } else {
              setSlot(i, {
                status: "done",
                mode: "stream",
                opId: response.opId,
                startedAt: Date.now(),
              });

              ensureSqlStreamStarted(response.opId);
            }
          } catch (err) {
            if (currentRunId(winId) !== runId) return;

            setSlot(i, {
              status: "error",
              error: formatQueryError(err, i),
              finishedAt: Date.now(),
            });

            if (stopOnError) bumpRunId(winId);
          }
        };

        let cursor = 0;

        const worker = async () => {
          while (cursor < list.length) {
            const i = cursor++;
            if (currentRunId(winId) !== runId) return;
            await runOne(i);
            if (stopOnError && currentRunId(winId) !== runId) return;
          }
        };

        const workers: Promise<void>[] = [];
        for (let k = 0; k < Math.min(CONCURRENCY, list.length); k++) {
          workers.push(worker());
        }

        setActiveResultIndex(0);
        await Promise.all(workers);
      } finally {
        // ✅ release inflight flag no matter what
        inflightByWindowRef.current.set(winId, false);
      }
    },
    [bumpRunId, currentRunId, onRunSql, runtimeConnectionId, stopOnError]
  );

  const reset = useCallback(() => {
    if (!activeSqlWindowId) return;
    const winId = activeSqlWindowId;

    const prev = stateByWindowIdRef.current.get(winId)?.slots;
    for (const s of prev ?? []) {
      if (s.mode === "stream" && s.opId) clearSqlStream(s.opId);
    }

    setSqlSlots(null);
    setActiveResultIndex(0);
    stateByWindowIdRef.current.set(winId, { slots: null, activeIndex: 0 });
    bumpRunId(winId);
  }, [activeSqlWindowId, bumpRunId]);

  const clearWindow = useCallback((windowId: string) => {
    const prev = stateByWindowIdRef.current.get(windowId)?.slots;
    for (const s of prev ?? []) {
      if (s.mode === "stream" && s.opId) clearSqlStream(s.opId);
    }
    stateByWindowIdRef.current.delete(windowId);
    runIdByWindowRef.current.delete(windowId);

    // cleanup gate refs
    inflightByWindowRef.current.delete(windowId);
    lastRunAtByWindowRef.current.delete(windowId);
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
