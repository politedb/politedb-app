import {
  effectiveSafetyMode,
  normalizeQuerySafetyMode,
  readNeedsTouchId,
  readTouchIdPrompt,
  type QuerySafetyMode,
} from "src/lib/queries/querySafety";
import { isMutatingStatement } from "src/lib/sql/detect";
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
 * Whether a dump may run on a tab, by the rules the SQL editor applies to
 * the same statements: Lock and Production block anything that changes the
 * database, Safe (and Production, for reads) asks for Touch ID first.
 * Before the file is read (`statements` null) a dump is assumed to write.
 */
export function dumpRunGate(
  mode: QuerySafetyMode | null,
  statements: readonly string[] | null,
  action: "restore" | "import"
): DumpRunGate {
  const done = action === "restore" ? "restored" : "imported";
  if (mode === null) {
    return {
      kind: "blocked",
      message: `The connection tab was closed: nothing was ${done}.`,
    };
  }
  const writes = statements === null || statements.some(isMutatingStatement);
  if (writes && mode === "lock") {
    return {
      kind: "blocked",
      message: `This tab is locked: nothing was ${done}. Unlock it to ${action} a dump.`,
    };
  }
  if (writes && mode === "production") {
    return {
      kind: "blocked",
      message: `Production mode blocks SQL that changes the database, so nothing was ${done}. Choose another safety mode to ${action} a dump.`,
    };
  }
  if (readNeedsTouchId(mode)) {
    return {
      kind: "touch-id",
      prompt: writes
        ? `Authenticate with Touch ID to ${action} a dump into this database.`
        : readTouchIdPrompt(mode),
    };
  }
  return { kind: "run" };
}
