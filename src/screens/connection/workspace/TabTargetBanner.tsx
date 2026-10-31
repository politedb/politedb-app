import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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

/*
 * The reconnect question (one native dialog at a time). A question is about
 * one situation: a tab, what it is opened on, its connection and the
 * problem. Its answer goes to the screen that shows that same situation
 * when it comes, if any; a screen that replaced the one that asked (left and
 * back) inherits the open question instead of asking twice. An answer with
 * nobody to take it authorizes nothing, and the question may be asked again.
 */
type Asker = { key: string; reconnect: () => void };

/** Situations answered while shown: not asked again. */
const answered = new Set<string>();
let open: { key: string; asker: Asker | null } | null = null;
const settledListeners = new Set<() => void>();

function ask(asker: Asker, question: string) {
  open = { key: asker.key, asker };
  void confirmDialog(question, {
    title: "Reconnect tab",
    kind: "warning",
    okLabel: "Reconnect",
    cancelLabel: "Not now",
  }).then(
    (ok) => settle(ok),
    () => settle(false)
  );
}

function settle(ok: boolean) {
  const question = open;
  open = null;
  const taker = question?.asker;
  if (question && taker && taker.key === question.key) {
    answered.add(question.key);
    if (ok) taker.reconnect();
  }
  // Screens waiting for the dialog (or left unanswered) may ask now.
  settledListeners.forEach((listener) => listener());
}

/**
 * A tab that cannot be used as it is: a connection it can reconnect (its
 * settings changed, or it is on another target) asks once, natively, and
 * reconnects on "Reconnect"; an unknown target, which only closing and
 * reopening the tab fixes, stays a banner.
 */
export function TabTargetBanner(props: {
  tabId: string;
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
  const intended = props.target.intended;
  const key =
    problem && canReconnect
      ? JSON.stringify([
          props.tabId,
          intended?.profileId ?? null,
          intended?.override ?? null,
          props.runtimeId ?? null,
          problem,
        ])
      : null;

  const reconnectRef = useRef(props.onReconnect);
  reconnectRef.current = props.onReconnect;
  const [settledTick, setSettledTick] = useState(0);
  useEffect(() => {
    const listener = () => setSettledTick((n) => n + 1);
    settledListeners.add(listener);
    return () => {
      settledListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!key || !problem || answered.has(key)) return;
    const asker: Asker = { key, reconnect: () => reconnectRef.current() };
    if (!open) ask(asker, problem);
    else if (open.key === key) open.asker = asker;
    // Another question is open: this one is asked once it settles.
    return () => {
      if (open?.asker === asker) open.asker = null;
    };
  }, [key, problem, settledTick]);

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
