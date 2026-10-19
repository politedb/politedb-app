import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { collectHealthInspectorSnapshot } from "src/lib/tauri/health-inspector";
import type { HealthInspectorSnapshot } from "src/lib/health-inspector/types";
import type { DatabaseEngine } from "src/types";
import { hasProAccess } from "src/lib/license/proAccess";
import { hasProAccessNow, useLicenseStore } from "src/stores/license";

export type HealthInspectorContext = {
  open: boolean;
  runtimeConnectionId?: string;
  profileId?: string | null;
  engine?: DatabaseEngine;
};

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
  const [error, setError] = useState<string | null>(null);
  const [proAccess, setProAccess] = useState(() =>
    hasProAccess(useLicenseStore.getState().state)
  );

  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const contextKey = `${ctx.profileId ?? ""}::${ctx.runtimeConnectionId ?? ""}::${ctx.engine ?? ""}`;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const clear = useCallback(() => {
    cancel();
    generationRef.current += 1;
    setSnapshot(null);
    setLoading(false);
    setError(null);
  }, [cancel]);

  const refresh = useCallback(async () => {
    if (!ctx.open) return;
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
      setError("Database Health Inspector currently supports PostgreSQL only.");
      setSnapshot(null);
      setLoading(false);
      return;
    }

    // Invalidate in-flight work (no overlapping refreshes)
    cancel();
    const generation = ++generationRef.current;
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(null);

    const result = await collectHealthInspectorSnapshot({
      runtimeConnectionId: ctx.runtimeConnectionId,
      profileId: ctx.profileId,
      engine: ctx.engine,
      signal: ac.signal,
    });

    if (generation !== generationRef.current) {
      return;
    }

    if (abortRef.current === ac) {
      abortRef.current = null;
    }

    setSnapshot(result);
    setLoading(false);
    if (result.cancelled) {
      setError(null);
    } else if (result.overallError && !hasAnySectionData(result)) {
      setError(result.overallError);
    }
  }, [
    cancel,
    clear,
    ctx.engine,
    ctx.open,
    ctx.profileId,
    ctx.runtimeConnectionId,
  ]);

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

  return {
    snapshot,
    loading,
    error,
    refresh,
    cancel,
    clear,
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
