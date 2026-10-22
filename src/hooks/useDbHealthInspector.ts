import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { collectHealthInspectorSnapshot } from "src/lib/tauri/health-inspector";
import type { HealthInspectorSnapshot } from "src/lib/health-inspector/types";
import type { DatabaseEngine } from "src/types";
import { hasProAccess } from "src/lib/license/proAccess";
import { hasProAccessNow, useLicenseStore } from "src/stores/license";
import {
  signalHealthInspectorBackend,
  type SessionActionKind,
  type SessionActionOutcome,
} from "src/lib/tauri/health-inspector-actions";
import { trackHealthInspectorSessionAction } from "src/lib/analytics";

export type HealthInspectorContext = {
  open: boolean;
  runtimeConnectionId?: string;
  profileId?: string | null;
  engine?: DatabaseEngine;
  /**
   * Re-collect this long after each finished snapshot (null = off). These
   * background refreshes keep the current snapshot on screen and swap it only
   * when the new one is complete; they pause while the window is hidden and
   * after a cancelled snapshot.
   */
  autoRefreshMs?: number | null;
};

type RefreshOptions = {
  background?: boolean;
  /** The reconciliation refresh owned by a session action. */
  fromAction?: boolean;
};

export type SessionActionRequest = {
  pid: number;
  backendToken: string;
  kind: SessionActionKind;
};

export type SessionActionState = SessionActionRequest & {
  phase: "confirming" | "sending" | "refreshing";
};

export type SessionActionResult = SessionActionRequest & {
  outcome: SessionActionOutcome;
};

const sessionKey = (pid: number, token: string) => `${pid}:${token}`;

/**
 * Owns one authoritative in-memory snapshot per runtime context.
 * Opening loads once; Refresh replaces; Cancel aborts Inspector-owned ops only.
 * Context changes clear results (no cross-profile leak).
 * Pro-only: no collection starts without Pro access (checked at call time), and losing
 * access invalidates any pending collection so its late result is dropped.
 */
export function useDbHealthInspector(ctx: HealthInspectorContext) {
  const [snapshot, setSnapshot] = useState<HealthInspectorSnapshot | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  /** A background (auto) refresh is running behind the current snapshot. */
  const [refreshing, setRefreshing] = useState(false);
  /** Bumped to re-arm the auto-refresh timer after a skipped (hidden) tick. */
  const [autoTick, setAutoTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [proAccess, setProAccess] = useState(() =>
    hasProAccess(useLicenseStore.getState().state)
  );

  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  // Session actions (plan .agent/plans/health-inspector-session-actions.md).
  // The epoch changes on clear (close, context change, Pro lost); attempts and
  // the lock are separate from collection generations.
  const [sessionAction, setSessionAction] = useState<SessionActionState | null>(
    null
  );
  const [sessionActionResult, setSessionActionResult] =
    useState<SessionActionResult | null>(null);
  const epochRef = useRef(0);
  const attemptRef = useRef(0);
  const actionLockRef = useRef<number | null>(null);
  /** Rows whose last outcome was unknown -> generation when blocked. */
  const blockedRef = useRef(new Map<string, number>());
  const [, setBlockedVersion] = useState(0);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const contextKey = `${ctx.profileId ?? ""}::${ctx.runtimeConnectionId ?? ""}::${ctx.engine ?? ""}`;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const clear = useCallback(() => {
    cancel();
    generationRef.current += 1;
    epochRef.current += 1;
    actionLockRef.current = null;
    blockedRef.current = new Map();
    setSnapshot(null);
    setLoading(false);
    setRefreshing(false);
    setError(null);
    setSessionAction(null);
    setSessionActionResult(null);
  }, [cancel]);

  const refresh = useCallback(
    async (options?: RefreshOptions) => {
      const background = options?.background === true;
      if (!ctx.open) return;
      // A session action owns collection until its own reconciliation ends.
      if (actionLockRef.current !== null && !options?.fromAction) return;
      if (!hasProAccessNow()) {
        clear();
        return;
      }
      if (!ctx.runtimeConnectionId || !ctx.profileId || !ctx.engine) {
        setError("No active runtime connection.");
        setSnapshot(null);
        setLoading(false);
        return;
      }
      if (ctx.engine !== "postgres") {
        setError(
          "Database Health Inspector currently supports PostgreSQL only."
        );
        setSnapshot(null);
        setLoading(false);
        return;
      }

      // Invalidate in-flight work (no overlapping refreshes)
      cancel();
      const generation = ++generationRef.current;
      const ac = new AbortController();
      abortRef.current = ac;

      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setRefreshing(false);
        setError(null);
      }

      let result: HealthInspectorSnapshot;
      try {
        result = await collectHealthInspectorSnapshot({
          runtimeConnectionId: ctx.runtimeConnectionId,
          profileId: ctx.profileId,
          engine: ctx.engine,
          signal: ac.signal,
          // Manual refresh shows each section as soon as it is in; a background
          // refresh keeps the current snapshot until the new one is complete.
          onProgress: background
            ? undefined
            : (partial) => {
                if (generation === generationRef.current) setSnapshot(partial);
              },
        });
      } catch (err) {
        // The collector reports failures in the snapshot; a rejection is
        // unexpected. Leave a usable state (manual Refresh) for this generation.
        if (generation === generationRef.current) {
          if (abortRef.current === ac) abortRef.current = null;
          setLoading(false);
          setRefreshing(false);
        }
        throw err;
      }

      if (generation !== generationRef.current) {
        return;
      }

      if (abortRef.current === ac) {
        abortRef.current = null;
      }

      if (background) {
        setRefreshing(false);
        // A cancelled background refresh holds partial sections; keep the
        // complete snapshot already on screen.
        if (result.cancelled) return;
      }
      setSnapshot(result);
      setLoading(false);
      // A ready Sessions section newer than an unknown outcome unblocks its row.
      if (result.sessions.status === "ready" && blockedRef.current.size > 0) {
        let changed = false;
        for (const [key, blockedAt] of blockedRef.current) {
          if (blockedAt < generation) {
            blockedRef.current.delete(key);
            changed = true;
          }
        }
        if (changed) setBlockedVersion((n) => n + 1);
      }
      // Every accepted result sets the error, so a later success clears it.
      setError(
        !result.cancelled && result.overallError && !hasAnySectionData(result)
          ? result.overallError
          : null
      );
    },
    [
      cancel,
      clear,
      ctx.engine,
      ctx.open,
      ctx.profileId,
      ctx.runtimeConnectionId,
    ]
  );

  /**
   * Cancel the current query of, or terminate, one session. One attempt at a
   * time; `confirm` shows the confirmation. Re-checks everything after it,
   * invalidates collection before sending, reports the outcome once, then
   * refreshes. Never retries.
   */
  const runSessionAction = useCallback(
    async (request: SessionActionRequest, confirm: () => Promise<boolean>) => {
      const start = ctxRef.current;
      if (
        actionLockRef.current !== null ||
        !start.open ||
        start.engine !== "postgres" ||
        !start.runtimeConnectionId ||
        blockedRef.current.has(sessionKey(request.pid, request.backendToken))
      ) {
        return;
      }
      const runtimeConnectionId = start.runtimeConnectionId;
      const epoch = epochRef.current;
      const attempt = ++attemptRef.current;
      actionLockRef.current = attempt;
      const current = () =>
        epochRef.current === epoch && actionLockRef.current === attempt;
      const release = () => {
        if (!current()) return;
        actionLockRef.current = null;
        setSessionAction(null);
      };

      setSessionAction({ ...request, phase: "confirming" });
      let confirmed = false;
      try {
        confirmed = await confirm();
      } catch {
        confirmed = false;
      }
      const now = ctxRef.current;
      if (
        !confirmed ||
        !current() ||
        !now.open ||
        now.engine !== "postgres" ||
        now.runtimeConnectionId !== runtimeConnectionId ||
        !hasProAccessNow()
      ) {
        release();
        return;
      }

      setSessionAction({ ...request, phase: "sending" });
      // Collection started before the action must not land afterwards.
      cancel();
      generationRef.current += 1;
      setLoading(false);
      setRefreshing(false);

      const outcome = await signalHealthInspectorBackend({
        runtimeConnectionId,
        ...request,
      });
      // The event belongs to the attempt, even if the dialog closed meanwhile.
      trackHealthInspectorSessionAction(request.kind, outcome);
      if (!current()) return;

      setSessionActionResult({ ...request, outcome });
      if (outcome === "unknown") {
        blockedRef.current.set(
          sessionKey(request.pid, request.backendToken),
          generationRef.current
        );
        setBlockedVersion((n) => n + 1);
      }
      setSessionAction({ ...request, phase: "refreshing" });
      try {
        await refresh({ fromAction: true });
      } catch {
        // The outcome stays; manual Refresh remains available.
      } finally {
        release();
      }
    },
    [cancel, refresh]
  );

  const isSessionActionBlocked = useCallback(
    (pid: number, backendToken: string) =>
      blockedRef.current.has(sessionKey(pid, backendToken)),
    []
  );

  // Unmount ends the Inspector's lifetime: a confirmation resolving later must
  // never dispatch, and a completion must not write state or reconcile. An
  // already issued signal is not cancelled; its analytics still fires once.
  useEffect(
    () => () => {
      epochRef.current += 1;
      actionLockRef.current = null;
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    },
    []
  );

  // Follow license changes; losing Pro access drops any pending collection.
  useEffect(() => {
    setProAccess(hasProAccess(useLicenseStore.getState().state));
    return useLicenseStore.subscribe((store) => {
      const next = hasProAccess(store.state);
      setProAccess(next);
      if (!next) clear();
    });
  }, [clear]);

  // Clear on context identity change
  useEffect(() => {
    clear();
  }, [contextKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load once on open (and when Pro access returns); clear on close or without Pro
  useEffect(() => {
    if (!ctx.open || !proAccess) {
      clear();
      return;
    }
    void refresh();
    return () => {
      cancel();
    };
  }, [ctx.open, contextKey, proAccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh: one timer after each finished snapshot, never overlapping.
  const autoRefreshMs = ctx.autoRefreshMs ?? null;
  useEffect(() => {
    if (
      !autoRefreshMs ||
      sessionAction !== null ||
      !ctx.open ||
      !proAccess ||
      loading ||
      refreshing ||
      !snapshot?.finishedAt ||
      snapshot.cancelled
    ) {
      return;
    }
    const id = window.setTimeout(() => {
      if (typeof document !== "undefined" && document.hidden) {
        setAutoTick((n) => n + 1);
        return;
      }
      void refresh({ background: true });
    }, autoRefreshMs);
    return () => window.clearTimeout(id);
  }, [
    autoRefreshMs,
    autoTick,
    ctx.open,
    proAccess,
    loading,
    refreshing,
    snapshot,
    refresh,
    sessionAction,
  ]);

  return {
    snapshot,
    loading,
    refreshing,
    error,
    refresh,
    cancel,
    clear,
    sessionAction,
    sessionActionResult,
    runSessionAction,
    isSessionActionBlocked,
    supported: ctx.engine === "postgres",
    locked: !proAccess,
  };
}

function hasAnySectionData(snap: HealthInspectorSnapshot): boolean {
  return (
    snap.overview.status === "ready" ||
    snap.sessions.status === "ready" ||
    snap.statements.status === "ready" ||
    snap.tables.status === "ready" ||
    snap.indexes.status === "ready"
  );
}
