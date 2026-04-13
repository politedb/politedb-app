import {
  useCallback,
  useEffect,
  useMemo,
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
  subscribeSqlStream,
  getSqlStreamSnapshot,
} from "src/screens/connection/hooks/useSqlStreamResult";
import { isMutatingStatement } from "src/utils/detect";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";

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

// Persist SQL result state across component remounts (e.g. toggling bottom panel).
const stateByWindowId = new Map<string, WindowState>();
const runIdByWindow = new Map<string, number>();
const inflightByWindow = new Map<string, boolean>();
const lastRunAtByWindow = new Map<string, number>();

export function useSqlRunner(args: {
  activeSqlWindowId?: string;
  runtimeConnectionId?: string;
  isProfileLocked?: boolean;
  sqlSafetyMode?: "default" | "lock" | "safe";
  onRunSql: RunSqlFn;
  stopOnError?: boolean;
}) {
  const {
    activeSqlWindowId,
    runtimeConnectionId,
    isProfileLocked = false,
    sqlSafetyMode = "default",
    onRunSql,
    stopOnError = false,
  } = args;

  const getSaved = useCallback((): WindowState => {
    if (!activeSqlWindowId) return { slots: null, activeIndex: 0 };
    return stateByWindowId.get(activeSqlWindowId) ?? {
      slots: null,
      activeIndex: 0,
    };
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
    const saved = stateByWindowId.get(activeSqlWindowId);
    setSqlSlots(saved?.slots ?? null);
    setActiveResultIndex(saved?.activeIndex ?? 0);
  }, [activeSqlWindowId]);

  useEffect(() => {
    if (!activeSqlWindowId) return;
    stateByWindowId.set(activeSqlWindowId, {
      slots: sqlSlots,
      activeIndex: activeResultIndex,
    });
  }, [activeSqlWindowId, sqlSlots, activeResultIndex]);

  const bumpRunId = useCallback((windowId: string) => {
    const next = (runIdByWindow.get(windowId) ?? 0) + 1;
    runIdByWindow.set(windowId, next);
    return next;
  }, []);

  const currentRunId = useCallback((windowId: string) => {
    return runIdByWindow.get(windowId) ?? 0;
  }, []);

  const startRun = useCallback(
    async (payload: { windowId: string; sql: string }) => {
      const winId = payload.windowId;
      if (!runtimeConnectionId) return;

      // ✅ Gate 1: throttle
      const now = Date.now();
      const lastAt = lastRunAtByWindow.get(winId) ?? 0;
      if (now - lastAt < RUN_THROTTLE_MS) return;
      lastRunAtByWindow.set(winId, now);

      // ✅ Gate 2: single in-flight run per window
      if (inflightByWindow.get(winId)) return;
      inflightByWindow.set(winId, true);

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
          stateByWindowId.set(winId, { slots, activeIndex: 0 });
          bumpRunId(winId);
          return;
        }

        const list = v.statements;
        const effectiveMode =
          sqlSafetyMode === "lock" || isProfileLocked ? "lock" : sqlSafetyMode;

        if (effectiveMode === "default") {
          const confirmed = window.confirm(
            "Do you want to send this query?"
          );
          if (!confirmed) return;
        }

        if (effectiveMode === "safe") {
          try {
            await securityTouchIdAuthenticate(
              "Authenticate with Touch ID before sending queries."
            );
          } catch (err) {
            const slots: SqlResultSlot[] = [
              {
                index: 0,
                sql: list[0] ?? payload.sql,
                status: "error",
                error: `Touch ID authentication failed: ${unwrapErrorMessage(err)}`,
                finishedAt: Date.now(),
              },
            ];
            setSqlSlots(slots);
            setActiveResultIndex(0);
            stateByWindowId.set(winId, { slots, activeIndex: 0 });
            bumpRunId(winId);
            return;
          }
        }

        if (effectiveMode === "lock") {
          const blockedIndex = list.findIndex((stmt) => isMutatingStatement(stmt));
          if (blockedIndex >= 0) {
            const slots: SqlResultSlot[] = [
              {
                index: 0,
                sql: list[blockedIndex],
                status: "error",
                error:
                  "This profile tab is locked. SQL statements that modify the database are blocked.",
                finishedAt: Date.now(),
              },
            ];
            setSqlSlots(slots);
            setActiveResultIndex(0);
            stateByWindowId.set(winId, { slots, activeIndex: 0 });
            bumpRunId(winId);
            return;
          }
        }

        const runId = bumpRunId(winId);

        // clear previous stream caches for this window
        const prev = stateByWindowId.get(winId)?.slots;
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
        stateByWindowId.set(winId, {
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

          const cached = stateByWindowId.get(winId);
          if (!cached?.slots || !cached.slots[i]) return;
          const nextSlots = cached.slots.slice();
          nextSlots[i] = { ...nextSlots[i], ...patch } as SqlResultSlot;
          stateByWindowId.set(winId, {
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
                status: "running",
                mode: "stream",
                opId: response.opId,
                startedAt: Date.now(),
              });

              ensureSqlStreamStarted(response.opId);

              const syncStreamStatus = () => {
                if (currentRunId(winId) !== runId) return;

                const snapshot = getSqlStreamSnapshot(response.opId);
                if (snapshot.status === "done") {
                  setSlot(i, {
                    status: "done",
                    finishedAt: Date.now(),
                  });
                } else if (snapshot.status === "error") {
                  setSlot(i, {
                    status: "error",
                    error: formatQueryError(
                      snapshot.error ?? "Unknown error",
                      i
                    ),
                    finishedAt: Date.now(),
                  });
                }
              };

              const unsubStream = subscribeSqlStream(
                response.opId,
                syncStreamStatus
              );
              syncStreamStatus();

              window.setTimeout(() => {
                unsubStream();
              }, 65_000);
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
        inflightByWindow.set(winId, false);
      }
    },
    [
      bumpRunId,
      currentRunId,
      isProfileLocked,
      sqlSafetyMode,
      onRunSql,
      runtimeConnectionId,
      stopOnError,
    ]
  );

  const reset = useCallback(() => {
    if (!activeSqlWindowId) return;
    const winId = activeSqlWindowId;

    const prev = stateByWindowId.get(winId)?.slots;
    for (const s of prev ?? []) {
      if (s.mode === "stream" && s.opId) clearSqlStream(s.opId);
    }

    setSqlSlots(null);
    setActiveResultIndex(0);
    stateByWindowId.set(winId, { slots: null, activeIndex: 0 });
    bumpRunId(winId);
  }, [activeSqlWindowId, bumpRunId]);

  const clearWindow = useCallback((windowId: string) => {
    const prev = stateByWindowId.get(windowId)?.slots;
    for (const s of prev ?? []) {
      if (s.mode === "stream" && s.opId) clearSqlStream(s.opId);
    }
    stateByWindowId.delete(windowId);
    runIdByWindow.delete(windowId);

    // cleanup gate refs
    inflightByWindow.delete(windowId);
    lastRunAtByWindow.delete(windowId);
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
