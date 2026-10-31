import { useEffect, useState } from "preact/hooks";
import type { DatabaseObjectItem } from "src/types";
import {
  buildDropDatabaseObjectSql,
  objectKindSingular,
} from "src/lib/databaseObjects";
import { confirmDialog } from "src/lib/system-dialog";
import { runSqlQuery } from "src/lib/tauri/query";
import { useScreenStore } from "src/stores/screen";
import { showToast } from "src/stores/toast";
import { hasPendingWork, useObjectDraftStore } from "src/stores/objectDrafts";
import { editDraftKey, windowIdForDraftKey } from "src/lib/objectDraftKey";
import { useConnectionRuntimeCtx } from "../workspace/ConnectionRuntimeContext";
import { TabTargetError, assertTabTarget } from "src/lib/tabs/assertTabTarget";
import { runtimeWorkIsCurrent } from "src/lib/runtimeConnection";

/**
 * Objects being dropped, by profile and object id. Module-level so a second
 * drop of the same object stays blocked even if the sidebar remounts
 * (switching its tabs) while the first is still running.
 */
const droppingObjects = new Set<string>();
const droppingListeners = new Set<() => void>();

function setDropping(key: string, dropping: boolean) {
  if (dropping) droppingObjects.add(key);
  else droppingObjects.delete(key);
  // Every mounted user re-renders, so an open menu shows the current state.
  droppingListeners.forEach((listener) => listener());
}

function isProfileLockedNow(profileId: string) {
  return (
    useScreenStore.getState().profileTabs.find((t) => t.id === profileId)
      ?.isLocked ?? false
  );
}

/**
 * Dropping functions, procedures and triggers: confirmed natively like
 * dropping a table, one drop per object at a time, never on a locked
 * profile.
 */
export function useDropDatabaseObject(profileId: string) {
  const rt = useConnectionRuntimeCtx();
  const isProfileLocked = useScreenStore(
    (s) => s.profileTabs.find((t) => t.id === profileId)?.isLocked ?? false
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    droppingListeners.add(listener);
    return () => {
      droppingListeners.delete(listener);
    };
  }, []);

  const dropKey = (item: DatabaseObjectItem) => `${profileId}\0${item.id}`;

  const canDrop = (item: DatabaseObjectItem) =>
    item.capability.canDelete &&
    !!rt.runtimeConnectionId &&
    !isProfileLocked &&
    !droppingObjects.has(dropKey(item));

  const dropObject = async (item: DatabaseObjectItem) => {
    const connectionId = rt.runtimeConnectionId;
    const key = dropKey(item);
    // Taken before the confirmation, so the object cannot be dropped twice.
    if (!connectionId || droppingObjects.has(key)) return;
    if (isProfileLockedNow(profileId)) return;
    setDropping(key, true);
    const kind = objectKindSingular(item.kind);
    // The drop's results belong to this tab's connection as it is now (R5).
    const isCurrent = runtimeWorkIsCurrent(connectionId);
    try {
      // D3: the tab's own connection, on its target, before asking...
      assertTabTarget(profileId, connectionId);
      const pending =
        useObjectDraftStore.getState().drafts[profileId]?.[
          editDraftKey(item.id)
        ];
      const loses =
        pending && hasPendingWork(pending)
          ? " Your unsaved edits to it will be discarded."
          : "";
      const ok = await confirmDialog(
        `Permanently drop the ${kind} "${item.schema}.${item.name}"? This cannot be undone.${loses}`,
        {
          title: `Drop ${kind}`,
          kind: "warning",
          okLabel: "Drop",
          cancelLabel: "Cancel",
        }
      );
      // The profile may have been locked while the dialog was open.
      if (!ok || isProfileLockedNow(profileId)) return;
      // ...and again after the answer: it may have reconnected meanwhile.
      assertTabTarget(profileId, connectionId);
      const sql = buildDropDatabaseObjectSql({ engine: rt.engine, item });
      await runSqlQuery(connectionId, sql);
      if (!isCurrent()) return;
      // The object is gone: so are its editor and draft.
      const draftKey = editDraftKey(item.id);
      useObjectDraftStore.getState().remove(profileId, draftKey);
      const windowId = windowIdForDraftKey(draftKey);
      const screen = useScreenStore.getState();
      if (
        (screen.openWindows[profileId] ?? []).some((w) => w.id === windowId)
      ) {
        screen.removeWindows(profileId, [windowId]);
      }
      await rt.refreshSchemaAndTables();
      if (!isCurrent()) return;
      showToast(`Dropped ${kind} “${item.name}”.`, { tone: "success" });
    } catch (err) {
      // A tab refusal is always shown; another failure only while current.
      if (!isCurrent() && !(err instanceof TabTargetError)) return;
      showToast(err instanceof Error ? err.message : String(err ?? ""), {
        tone: "error",
      });
    } finally {
      setDropping(key, false);
    }
  };

  return { canDrop, dropObject };
}
