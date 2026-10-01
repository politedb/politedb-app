import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { DatabaseEngine } from "src/types";
import {
  loadStandaloneExportMetadata,
  sanitizeStandaloneExportError,
} from "../export/standalone-export/loadStandaloneExportMetadata";
import { canStandaloneExportTable } from "../export/standalone-export/support";
import type {
  StandaloneExportPhase,
  StandaloneExportTarget,
} from "../export/standalone-export/types";

export type UseStandaloneTableExportArgs = {
  profileScreenId: string;
  runtimeConnectionId: string | undefined;
  engine: DatabaseEngine | undefined;
  target: StandaloneExportTarget | null;
  onClearTarget: () => void;
};

/**
 * Connection-owned orchestration for standalone (no-tab) table export.
 * One session at a time; stale metadata completions are ignored.
 */
export function useStandaloneTableExport(args: UseStandaloneTableExportArgs) {
  const {
    profileScreenId,
    runtimeConnectionId,
    engine,
    target,
    onClearTarget,
  } = args;
  const [phase, setPhase] = useState<StandaloneExportPhase>({ status: "idle" });
  const requestIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const cancelInFlight = useCallback(() => {
    cancelledRef.current = true;
    requestIdRef.current = null;
  }, []);

  const close = useCallback(() => {
    cancelInFlight();
    setPhase({ status: "idle" });
    onClearTarget();
  }, [cancelInFlight, onClearTarget]);

  const loadForTarget = useCallback(
    async (next: StandaloneExportTarget) => {
      if (!canStandaloneExportTable(next.engine)) {
        setPhase({
          status: "error",
          target: next,
          message: "Standalone export is not available for this engine.",
        });
        return;
      }
      if (!runtimeConnectionId || runtimeConnectionId !== next.connectionId) {
        setPhase({
          status: "error",
          target: next,
          message: "Connection is not available.",
        });
        return;
      }

      cancelledRef.current = false;
      requestIdRef.current = next.requestId;
      setPhase({ status: "loading", target: next });

      try {
        const metadata = await loadStandaloneExportMetadata({
          profileScreenId,
          connectionId: next.connectionId,
          engine: next.engine,
          schema: next.schema,
          tableName: next.tableName,
          estimatedRow: next.estimatedRow,
          isCancelled: () =>
            cancelledRef.current || requestIdRef.current !== next.requestId,
        });

        if (cancelledRef.current || requestIdRef.current !== next.requestId) {
          return;
        }

        setPhase({ status: "ready", target: next, metadata });
      } catch (err) {
        if (cancelledRef.current || requestIdRef.current !== next.requestId) {
          return;
        }
        setPhase({
          status: "error",
          target: next,
          message: sanitizeStandaloneExportError(err),
        });
      }
    },
    [profileScreenId, runtimeConnectionId]
  );

  // Drive metadata load from immutable target; replace cancels prior request.
  useEffect(() => {
    if (!target) {
      cancelInFlight();
      setPhase({ status: "idle" });
      return;
    }
    void loadForTarget(target);
  }, [target, loadForTarget, cancelInFlight]);

  // Disconnect / engine change invalidates any open session.
  useEffect(() => {
    if (phase.status === "idle") return;
    const active = phase.target;
    if (
      !runtimeConnectionId ||
      runtimeConnectionId !== active.connectionId ||
      (engine && engine !== active.engine)
    ) {
      cancelInFlight();
      setPhase({ status: "idle" });
      onClearTarget();
    }
  }, [runtimeConnectionId, engine, phase, cancelInFlight, onClearTarget]);

  // Unmount: cancel in-flight metadata.
  useEffect(() => {
    return () => {
      cancelInFlight();
    };
  }, [cancelInFlight]);

  const retry = useCallback(() => {
    if (!target) return;
    void loadForTarget(target);
  }, [target, loadForTarget]);

  return {
    phase,
    close,
    retry,
  };
}
