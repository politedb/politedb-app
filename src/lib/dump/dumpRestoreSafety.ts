import {
  effectiveSafetyMode,
  normalizeQuerySafetyMode,
  readNeedsTouchId,
  type QuerySafetyMode,
} from "src/lib/queries/querySafety";
import { useScreenStore } from "src/stores/screen";

/** The tab's safety mode right now (a locked tab is Lock), or null once closed. */
export function tabSafetyModeNow(tabId: string): QuerySafetyMode | null {
  const tab = useScreenStore
    .getState()
    .profileTabs.find((item) => item.id === tabId);
  if (!tab) return null;
  const mode = normalizeQuerySafetyMode(
    tab.querySafetyMode ?? (tab.isLocked ? "lock" : "default")
  );
  return effectiveSafetyMode(mode, !!tab.isLocked);
}

export type DumpRunGate =
  | { kind: "run" }
  | { kind: "touch-id"; prompt: string }
  | { kind: "blocked"; message: string };

/**
 * Whether a dump may run on a tab in its current safety mode. A dump exists
 * to change the database, so Lock and Production refuse it outright rather
 * than trust a per-statement guess at what is a read; Safe asks for Touch
 * ID first.
 */
export function dumpRunGate(
  mode: QuerySafetyMode | null,
  action: "restore" | "import",
  /** Some statements already ran: "nothing more" was done. */
  started = false
): DumpRunGate {
  const done = `${started ? "nothing more" : "nothing"} was ${action === "restore" ? "restored" : "imported"}`;
  if (mode === null) {
    return {
      kind: "blocked",
      message: `The connection tab was closed, so ${done}.`,
    };
  }
  if (mode === "lock") {
    return {
      kind: "blocked",
      message: `This tab is locked, so ${done}. Unlock it to ${action} a dump.`,
    };
  }
  if (mode === "production") {
    return {
      kind: "blocked",
      message: `Production mode blocks SQL that changes the database, so ${done}. Choose another safety mode to ${action} a dump.`,
    };
  }
  if (readNeedsTouchId(mode)) {
    return {
      kind: "touch-id",
      prompt: `Authenticate with Touch ID to ${action} a dump into this database.`,
    };
  }
  return { kind: "run" };
}
