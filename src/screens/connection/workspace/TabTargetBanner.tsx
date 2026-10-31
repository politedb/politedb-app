import { useEffect, useMemo, useRef } from "preact/hooks";
import { confirmDialog } from "src/lib/system-dialog";
import {
  RUNTIME_STALE_MESSAGE,
  RUNTIME_UNCONFIRMED_MESSAGE,
  TAB_TARGET_UNKNOWN,
} from "src/lib/tabs/assertTabTarget";
import { targetMatches, type ResolvedTabTarget } from "src/lib/tabs/tabTarget";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";

/**
 * Why this tab cannot be used as it is, or null (plan
 * tab-database-reconnect D1, R6, R7): unknown target, a connection the
 * backend refused (its profile was saved again or removed), or a connection
 * opened on something other than the tab's target.
 */
export function tabTargetProblem(
  target: ResolvedTabTarget,
  runtimeId: string | undefined,
  targets: ReturnType<typeof useRuntimeTargetsStore.getState>["targets"],
  refused: ReturnType<typeof useRuntimeTargetsStore.getState>["refused"]
): string | null {
  if (target.state === "unknown") return TAB_TARGET_UNKNOWN;
  if (!runtimeId) return null;
  if (refused[runtimeId]) return RUNTIME_STALE_MESSAGE;
  const runtime = targets[runtimeId];
  // Not recorded in this session: the backend still checks every use.
  if (runtime === undefined) return null;
  if (runtime === null) {
    return RUNTIME_UNCONFIRMED_MESSAGE;
  }
  if (!targetMatches(target.intended, runtime)) {
    return `This tab shows ${target.display || "its database"} but is connected to ${runtime.display || "another database"}. Reconnect the tab.`;
  }
  return null;
}

/** Problems already asked about, so a remount or re-render asks once. */
const askedReconnect = new Set<string>();

/**
 * A tab that cannot be used as it is: a connection it can reconnect (its
 * settings changed, or it is on another target) asks once, natively, and
 * reconnects on "Reconnect"; an unknown target, which only closing and
 * reopening the tab fixes, stays a banner.
 */
export function TabTargetBanner(props: {
  target: ResolvedTabTarget;
  runtimeId: string | undefined;
  onReconnect: () => void;
}) {
  const targets = useRuntimeTargetsStore((s) => s.targets);
  const refused = useRuntimeTargetsStore((s) => s.refused);
  const problem = useMemo(
    () => tabTargetProblem(props.target, props.runtimeId, targets, refused),
    [props.target, props.runtimeId, targets, refused]
  );
  const canReconnect = props.target.state === "ok";

  const reconnectRef = useRef(props.onReconnect);
  reconnectRef.current = props.onReconnect;
  const currentRef = useRef({ problem, runtimeId: props.runtimeId });
  currentRef.current = { problem, runtimeId: props.runtimeId };

  useEffect(() => {
    if (!problem || !canReconnect) return;
    const runtimeId = props.runtimeId;
    const key = `${runtimeId ?? ""}\0${problem}`;
    if (askedReconnect.has(key)) return;
    askedReconnect.add(key);
    void confirmDialog(problem, {
      title: "Reconnect connection",
      kind: "warning",
      okLabel: "Reconnect",
      cancelLabel: "Not now",
    }).then((ok) => {
      // Only for the problem asked about: the tab may have moved on.
      const now = currentRef.current;
      if (ok && now.problem === problem && now.runtimeId === runtimeId) {
        reconnectRef.current();
      }
    });
  }, [problem, canReconnect, props.runtimeId]);

  if (!problem || canReconnect) return null;
  return (
    <div
      role="alert"
      class="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <span class="flex-1">{problem}</span>
    </div>
  );
}
