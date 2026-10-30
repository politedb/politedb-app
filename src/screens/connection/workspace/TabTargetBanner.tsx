import { useMemo } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { TAB_TARGET_UNKNOWN } from "src/lib/runtimeConnection";
import { targetMatches, type ResolvedTabTarget } from "src/lib/tabs/tabTarget";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";

export const RUNTIME_STALE_MESSAGE =
  "The connection settings changed. Reconnect this tab.";

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
    return "This tab's connection could not be confirmed. Reconnect the tab.";
  }
  if (!targetMatches(target.intended, runtime)) {
    return `This tab shows ${target.display || "its database"} but is connected to ${runtime.display || "another database"}. Reconnect the tab.`;
  }
  return null;
}

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
  if (!problem) return null;
  const canReconnect = props.target.state === "ok";
  return (
    <div
      role="alert"
      class="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <span class="flex-1">{problem}</span>
      {canReconnect ? (
        <Button variant="outline" onClick={props.onReconnect}>
          Reconnect
        </Button>
      ) : null}
    </div>
  );
}
