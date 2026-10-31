import { useScreenStore } from "src/stores/screen";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";

/**
 * Changes whenever work on `runtimeId` loses publication authority (R5):
 * the tab using it changed epoch or connection, or the backend refused it.
 * Hooks with local pending state retire their obsolete requests on change.
 */
export function useRuntimeLifetime(runtimeId: string | undefined): string {
  const tabLifetime = useScreenStore((s) => {
    if (!runtimeId) return "";
    const tab = s.profileTabs.find((t) => t.runtimeConnectionId === runtimeId);
    return tab ? `${tab.id}:${s.tabEpoch[tab.id] ?? 0}` : "none";
  });
  const refused = useRuntimeTargetsStore((s) =>
    runtimeId ? (s.refused[runtimeId] ?? "") : ""
  );
  return `${runtimeId ?? ""}|${tabLifetime}|${refused}`;
}
