import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { DatabaseEngine } from "src/types";
import type { SqlResultRun, SqlResultSlot } from "src/lib/tauri";
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
import { operationCancel } from "src/lib/tauri/operation";
import { isMutatingStatement } from "src/utils/detect";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import { buildExplainSql } from "src/lib/queries/sql/explain";
import type { QuerySafetyMode } from "src/lib/querySafety";

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
  runs: SqlResultRun[];
  activeRunId: string | null;
  activeSlotIndex: number;
};

const CONCURRENCY = 2;
const MAX_RUNS_PER_WINDOW = 10;

// Gate settings
const RUN_THROTTLE_MS = 400;

// Persist SQL result state across component remounts (e.g. toggling bottom panel).
const stateByWindowId = new Map<string, WindowState>();
const runIdByWindow = new Map<string, number>();
const inflightByWindow = new Map<string, boolean>();
const lastRunAtByWindow = new Map<string, number>();

function emptyWindowState(): WindowState {
  return { runs: [], activeRunId: null, activeSlotIndex: 0 };
}

function cleanupRun(run: SqlResultRun) {
  for (const slot of run.slots) {
    if (slot.mode === "stream" && slot.opId) clearSqlStream(slot.opId);
  }
}

function cancelRunOperations(run: SqlResultRun) {
  for (const slot of run.slots) {
    if (slot.mode !== "stream" || !slot.opId) continue;
    void operationCancel(slot.opId).catch(() => {});
    clearSqlStream(slot.opId);
  }
}

export function clearSqlRunnerWindowState(windowId: string) {
  const prev = stateByWindowId.get(windowId)?.runs;
  for (const run of prev ?? []) {
    cancelRunOperations(run);
    cleanupRun(run);
  }

  stateByWindowId.delete(windowId);
  runIdByWindow.delete(windowId);
  inflightByWindow.delete(windowId);
  lastRunAtByWindow.delete(windowId);
}

function pruneRuns(runs: SqlResultRun[]) {
  if (runs.length <= MAX_RUNS_PER_WINDOW) return runs;

  const next = runs.slice();
  while (next.length > MAX_RUNS_PER_WINDOW) {
    const removableIndex = next.findIndex((run) =>
      run.slots.every((slot) => slot.status !== "running")
    );
    const index = removableIndex >= 0 ? removableIndex : 0;
    const [removed] = next.splice(index, 1);
    if (removed) cleanupRun(removed);
  }

  return next;
}

function makeRunId(kind: SqlResultRun["kind"]) {
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeRunTitle(kind: SqlResultRun["kind"], index: number) {
  return kind === "explain" ? `Explain ${index}` : `Query ${index}`;
}

function createErrorRun(args: {
  kind: SqlResultRun["kind"];
  title: string;
  sql: string;
  error: string;
}): SqlResultRun {
  return {
    id: makeRunId(args.kind),
    kind: args.kind,
    title: args.title,
    createdAt: Date.now(),
    sql: args.sql,
    slots: [
      {
        index: 0,
        sql: args.sql,
        status: "error",
        error: args.error,
        finishedAt: Date.now(),
      },
    ],
  };
}

export function useSqlRunner(args: {
  activeSqlWindowId?: string;
  runtimeConnectionId?: string;
  engine: DatabaseEngine;
  isProfileLocked?: boolean;
  sqlSafetyMode?: QuerySafetyMode;
  onRunSql: RunSqlFn;
  stopOnError?: boolean;
}) {
  const {
    activeSqlWindowId,
    runtimeConnectionId,
    engine,
    isProfileLocked = false,
    sqlSafetyMode = "default",
    onRunSql,
    stopOnError = false,
  } = args;

  const getSaved = useCallback((): WindowState => {
    if (!activeSqlWindowId) return emptyWindowState();
    return stateByWindowId.get(activeSqlWindowId) ?? emptyWindowState();
  }, [activeSqlWindowId]);

  const initial = useMemo(() => getSaved(), [getSaved]);

  const [sqlRuns, setSqlRuns] = useState<SqlResultRun[]>(initial.runs);
  const [activeRunId, setActiveRunId] = useState<string | null>(
    initial.activeRunId
  );
  const [activeResultIndex, setActiveResultIndex] = useState<number>(
    initial.activeSlotIndex
  );

  useEffect(() => {
    if (!activeSqlWindowId) return;
    const saved = stateByWindowId.get(activeSqlWindowId) ?? emptyWindowState();
    setSqlRuns(saved.runs);
    setActiveRunId(saved.activeRunId);
    setActiveResultIndex(saved.activeSlotIndex);
  }, [activeSqlWindowId]);

  useEffect(() => {
    if (!activeSqlWindowId) return;
    stateByWindowId.set(activeSqlWindowId, {
      runs: sqlRuns,
      activeRunId,
      activeSlotIndex: activeResultIndex,
    });
  }, [activeSqlWindowId, sqlRuns, activeRunId, activeResultIndex]);

  const bumpRunId = useCallback((windowId: string) => {
    const next = (runIdByWindow.get(windowId) ?? 0) + 1;
    runIdByWindow.set(windowId, next);
    return next;
  }, []);

  const currentRunId = useCallback((windowId: string) => {
    return runIdByWindow.get(windowId) ?? 0;
  }, []);

  const saveWindowState = useCallback(
    (winId: string, patch: Partial<WindowState>) => {
      const previous = stateByWindowId.get(winId) ?? emptyWindowState();
      const next = { ...previous, ...patch };
      stateByWindowId.set(winId, next);
      setSqlRuns(next.runs);
      setActiveRunId(next.activeRunId);
      setActiveResultIndex(next.activeSlotIndex);
    },
    []
  );

  const appendRun = useCallback(
    (winId: string, run: SqlResultRun) => {
      const previous = stateByWindowId.get(winId) ?? emptyWindowState();
      const runs = pruneRuns([...previous.runs, run]);
      saveWindowState(winId, {
        runs,
        activeRunId: run.id,
        activeSlotIndex: 0,
      });
    },
    [saveWindowState]
  );

  const setSlot = useCallback(
    (
      winId: string,
      resultRunId: string,
      i: number,
      patch: Partial<SqlResultSlot>
    ) => {
      const cached = stateByWindowId.get(winId);
      if (!cached) return;

      const runIndex = cached.runs.findIndex((run) => run.id === resultRunId);
      if (runIndex < 0) return;

      const run = cached.runs[runIndex];
      const slot = run.slots[i];
      if (!slot) return;

      const nextSlots = run.slots.slice();
      nextSlots[i] = { ...slot, ...patch };

      const nextRuns = cached.runs.slice();
      nextRuns[runIndex] = { ...run, slots: nextSlots };

      saveWindowState(winId, { runs: nextRuns });
    },
    [saveWindowState]
  );

  const runStatements = useCallback(
    async (args: {
      windowId: string;
      kind: SqlResultRun["kind"];
      sourceSql: string;
      statements: string[];
      validateBeforeRun: boolean;
    }) => {
      const winId = args.windowId;
      if (!runtimeConnectionId) return;

      const runIndex =
        (stateByWindowId.get(winId)?.runs.length ?? sqlRuns.length) + 1;
      const resultRunId = makeRunId(args.kind);
      const initialSlots: SqlResultSlot[] = args.statements.map((sql, i) => ({
        index: i,
        sql,
        status: "queued",
      }));

      const resultRun: SqlResultRun = {
        id: resultRunId,
        kind: args.kind,
        title: makeRunTitle(args.kind, runIndex),
        createdAt: Date.now(),
        sql: args.sourceSql,
        slots: initialSlots,
      };

      const runId = bumpRunId(winId);
      appendRun(winId, resultRun);

      const runOne = async (i: number) => {
        if (currentRunId(winId) !== runId) return;

        setSlot(winId, resultRunId, i, {
          status: "running",
          startedAt: Date.now(),
        });

        try {
          if (args.validateBeforeRun) {
            await validateSqlQueryBE(runtimeConnectionId, args.statements[i], {
              timeoutMs: 20_000,
              statementTimeoutMs: 15_000,
            });
          }

          if (currentRunId(winId) !== runId) return;

          const response = await onRunSql({
            windowId: winId,
            connectionId: runtimeConnectionId,
            sql: args.statements[i],
          });

          if (currentRunId(winId) !== runId) return;

          if (response.mode === "direct") {
            setSlot(winId, resultRunId, i, {
              status: "done",
              mode: "direct",
              result: response.result,
              finishedAt: Date.now(),
            });
            return;
          }

          setSlot(winId, resultRunId, i, {
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
              setSlot(winId, resultRunId, i, {
                status: "done",
                finishedAt: Date.now(),
              });
            } else if (snapshot.status === "error") {
              setSlot(winId, resultRunId, i, {
                status: "error",
                error: formatQueryError(snapshot.error ?? "Unknown error", i),
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
        } catch (err) {
          if (currentRunId(winId) !== runId) return;

          setSlot(winId, resultRunId, i, {
            status: "error",
            error: formatQueryError(err, i),
            finishedAt: Date.now(),
          });

          if (stopOnError) bumpRunId(winId);
        }
      };

      let cursor = 0;

      const worker = async () => {
        while (cursor < args.statements.length) {
          const i = cursor++;
          if (currentRunId(winId) !== runId) return;
          await runOne(i);
          if (stopOnError && currentRunId(winId) !== runId) return;
        }
      };

      const workers: Promise<void>[] = [];
      for (let k = 0; k < Math.min(CONCURRENCY, args.statements.length); k++) {
        workers.push(worker());
      }

      await Promise.all(workers);
    },
    [
      appendRun,
      bumpRunId,
      currentRunId,
      onRunSql,
      runtimeConnectionId,
      setSlot,
      sqlRuns.length,
      stopOnError,
    ]
  );

  const startRun = useCallback(
    async (payload: { windowId: string; sql: string }) => {
      const winId = payload.windowId;
      if (!runtimeConnectionId) return;

      const now = Date.now();
      const lastAt = lastRunAtByWindow.get(winId) ?? 0;
      if (now - lastAt < RUN_THROTTLE_MS) return;
      lastRunAtByWindow.set(winId, now);

      if (inflightByWindow.get(winId)) return;
      inflightByWindow.set(winId, true);

      try {
        const v = validateSqlClient(payload.sql);
        if (!v.ok) {
          appendRun(
            winId,
            createErrorRun({
              kind: "query",
              title: "Run error",
              sql: payload.sql,
              error: v.message,
            })
          );
          bumpRunId(winId);
          return;
        }

        const list = v.statements;
        const effectiveMode =
          sqlSafetyMode === "lock" || isProfileLocked ? "lock" : sqlSafetyMode;

        if (effectiveMode === "production") {
          const blockedIndex = list.findIndex((stmt) =>
            isMutatingStatement(stmt)
          );
          if (blockedIndex >= 0) {
            appendRun(
              winId,
              createErrorRun({
                kind: "query",
                title: "Production block",
                sql: list[blockedIndex],
                error:
                  "Production mode blocks SQL statements that modify the database.",
              })
            );
            bumpRunId(winId);
            return;
          }
        }

        if (effectiveMode === "lock") {
          const blockedIndex = list.findIndex((stmt) =>
            isMutatingStatement(stmt)
          );
          if (blockedIndex >= 0) {
            appendRun(
              winId,
              createErrorRun({
                kind: "query",
                title: "Locked",
                sql: list[blockedIndex],
                error:
                  "This profile tab is locked. SQL statements that modify the database are blocked.",
              })
            );
            bumpRunId(winId);
            return;
          }
        }

        if (effectiveMode === "safe" || effectiveMode === "production") {
          try {
            await securityTouchIdAuthenticate(
              effectiveMode === "production"
                ? "Authenticate with Touch ID before reading production data."
                : "Authenticate with Touch ID before sending queries."
            );
          } catch (err) {
            appendRun(
              winId,
              createErrorRun({
                kind: "query",
                title: "Auth failed",
                sql: list[0] ?? payload.sql,
                error: `Touch ID authentication failed: ${unwrapErrorMessage(err)}`,
              })
            );
            bumpRunId(winId);
            return;
          }
        }

        await runStatements({
          windowId: winId,
          kind: "query",
          sourceSql: payload.sql,
          statements: list,
          validateBeforeRun: true,
        });
      } finally {
        inflightByWindow.set(winId, false);
      }
    },
    [
      appendRun,
      bumpRunId,
      isProfileLocked,
      runStatements,
      runtimeConnectionId,
      sqlSafetyMode,
    ]
  );

  const startExplain = useCallback(
    async (payload: { windowId: string; sql: string }) => {
      const winId = payload.windowId;
      if (!runtimeConnectionId) return;

      const now = Date.now();
      const lastAt = lastRunAtByWindow.get(winId) ?? 0;
      if (now - lastAt < RUN_THROTTLE_MS) return;
      lastRunAtByWindow.set(winId, now);

      if (inflightByWindow.get(winId)) return;
      inflightByWindow.set(winId, true);

      try {
        const explain = buildExplainSql(engine, payload.sql);
        if (explain.error || !explain.sql) {
          appendRun(
            winId,
            createErrorRun({
              kind: "explain",
              title: "Explain error",
              sql: payload.sql,
              error:
                explain.error ??
                "Explain is not supported for this engine yet.",
            })
          );
          bumpRunId(winId);
          return;
        }

        const explainSql: string = explain.sql;
        await runStatements({
          windowId: winId,
          kind: "explain",
          sourceSql: payload.sql,
          statements: [explainSql],
          validateBeforeRun: false,
        });
      } finally {
        inflightByWindow.set(winId, false);
      }
    },
    [appendRun, bumpRunId, engine, runStatements, runtimeConnectionId]
  );

  const reset = useCallback(() => {
    if (!activeSqlWindowId) return;
    const winId = activeSqlWindowId;

    const prev = stateByWindowId.get(winId)?.runs;
    for (const run of prev ?? []) {
      cancelRunOperations(run);
      cleanupRun(run);
    }

    saveWindowState(winId, emptyWindowState());
    bumpRunId(winId);
  }, [activeSqlWindowId, bumpRunId, saveWindowState]);

  const closeRun = useCallback(
    (runId: string) => {
      if (!activeSqlWindowId) return;

      const cached = stateByWindowId.get(activeSqlWindowId);
      if (!cached) return;

      const index = cached.runs.findIndex((run) => run.id === runId);
      if (index < 0) return;

      const run = cached.runs[index];
      cancelRunOperations(run);
      cleanupRun(run);

      const runs = cached.runs.filter((entry) => entry.id !== runId);
      let nextActiveRunId = cached.activeRunId;
      let nextActiveSlotIndex = cached.activeSlotIndex;

      if (cached.activeRunId === runId) {
        const fallback = runs[Math.max(0, index - 1)] ?? runs[index] ?? null;
        nextActiveRunId = fallback?.id ?? null;
        nextActiveSlotIndex = 0;
      }

      saveWindowState(activeSqlWindowId, {
        runs,
        activeRunId: nextActiveRunId,
        activeSlotIndex: nextActiveSlotIndex,
      });
    },
    [activeSqlWindowId, saveWindowState]
  );

  const cancelRun = useCallback(
    (runId: string) => {
      if (!activeSqlWindowId) return;

      const cached = stateByWindowId.get(activeSqlWindowId);
      if (!cached) return;

      const runIndex = cached.runs.findIndex((run) => run.id === runId);
      if (runIndex < 0) return;

      const run = cached.runs[runIndex];
      cancelRunOperations(run);

      const finishedAt = Date.now();
      const nextSlots = run.slots.map((slot) => {
        if (slot.status !== "queued" && slot.status !== "running") return slot;
        return {
          ...slot,
          status: "error" as const,
          error: "Query was cancelled.",
          finishedAt,
        };
      });

      const nextRuns = cached.runs.slice();
      nextRuns[runIndex] = { ...run, slots: nextSlots };

      saveWindowState(activeSqlWindowId, { runs: nextRuns });
      bumpRunId(activeSqlWindowId);
      inflightByWindow.set(activeSqlWindowId, false);
    },
    [activeSqlWindowId, bumpRunId, saveWindowState]
  );

  const clearWindow = useCallback((windowId: string) => {
    clearSqlRunnerWindowState(windowId);
  }, []);

  return {
    sqlRuns,
    activeRunId,
    setActiveRunId,
    activeResultIndex,
    setActiveResultIndex,
    startRun,
    startExplain,
    closeRun,
    cancelRun,
    reset,
    clearWindow,
  };
}
