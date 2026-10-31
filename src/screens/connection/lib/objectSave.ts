import type { DatabaseEngine } from "src/types";
import { checkTabTarget } from "src/lib/tabs/assertTabTarget";
import { operationExecuteTransaction } from "src/lib/tauri";
import { runSqlQuery } from "src/lib/tauri/query";
import { normalizeSqlError } from "src/lib/tauri/queryValidate";
import { objectKindSingular } from "src/lib/databaseObjects";
import { collectPendingObjectSaveEntries } from "src/lib/objectEditorDraftCache";
import { draftKeyForWindow } from "src/lib/objectDraftKey";
import {
  hasPendingWork,
  objectDraftsForTab,
  useObjectDraftStore,
  type ObjectDraft,
} from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import { showToast } from "src/stores/toast";
import { openCreatedObject, type ObjectMetadataRefresh } from "./objectWindows";

/** Connection screen tabs with an object save running (one at a time). */
const objectSaveRuns = new Set<string>();

export function isObjectSaveRunning(tabId: string): boolean {
  return objectSaveRuns.has(tabId);
}

/** Close the windows of these drafts in one transition (open ones only). */
function closeDraftWindows(tabId: string, keys: Set<string>) {
  if (!keys.size) return;
  const screen = useScreenStore.getState();
  const ids = (screen.openWindows[tabId] ?? [])
    .filter(
      (w) => w.type === "db-object-manager" && keys.has(draftKeyForWindow(w))
    )
    .map((w) => w.id);
  if (ids.length) screen.removeWindows(tabId, ids);
}

/**
 * Save a connection screen tab's executable object drafts (closed windows
 * included), one run per tab at a time. Statements come from snapshots
 * taken first; completion only touches drafts whose generation still
 * matches. A successful CREATE consumes its draft (never replayed) and
 * closes its window; its toast offers to open the new object.
 * Throws when the statements fail; every draft then stays as it was.
 */
export async function saveObjectDraftsForTab(args: {
  tabId: string;
  engine: DatabaseEngine;
  resolveConnectionId: () => Promise<string | null | undefined>;
  /** Fresh metadata of a screen tab; without it, `refreshFallback` runs. */
  refreshObjectMetadata?: ObjectMetadataRefresh;
  refreshFallback: () => Promise<void>;
  setError: (message: string | null) => void;
}): Promise<void> {
  const { tabId, engine, refreshObjectMetadata } = args;
  if (objectSaveRuns.has(tabId)) return;

  const entries = collectPendingObjectSaveEntries({ tabId, engine });
  if (!entries.length) return;

  objectSaveRuns.add(tabId);
  const drafts = () => useObjectDraftStore.getState();
  const createKeys = entries
    .filter((entry) => entry.mode === "create")
    .map((entry) => entry.key);
  // Read-only from the snapshot on, before any await: what runs is what
  // the user last saw.
  for (const key of createKeys) drafts().setSaving(tabId, key, true);
  try {
    const connectionId = await args.resolveConnectionId();
    if (!connectionId) {
      args.setError("No active connection.");
      return;
    }
    // D3: only through the tab's own connection, on its target.
    const refusal = checkTabTarget(tabId, connectionId);
    if (refusal) {
      args.setError(refusal.message);
      return;
    }

    const statements = entries.flatMap((entry) => entry.statements);
    try {
      if (statements.length === 1) {
        await runSqlQuery(connectionId, statements[0]!);
      } else {
        await operationExecuteTransaction({ connectionId, statements });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      showToast(message, { tone: "error" });
      args.setError(normalizeSqlError(err));
      throw err;
    }

    // The statements ran: nothing below restores or re-runs a CREATE.
    const consumed = new Set<string>();
    const created: ObjectDraft[] = [];
    for (const entry of entries) {
      const { snapshot } = entry;
      if (entry.mode === "edit") {
        drafts().markSaved(tabId, entry.key, snapshot.generation, snapshot.sql);
        continue;
      }
      const current = drafts().drafts[tabId]?.[entry.key];
      if (current && current.generation === snapshot.generation) {
        drafts().remove(tabId, entry.key);
        consumed.add(entry.key);
      }
      created.push(snapshot);
    }
    closeDraftWindows(tabId, consumed);

    // Missing objects are reconciled by the metadata load itself
    // (objectReconcile), with its own tab, connection and lifetime checks.
    if (refreshObjectMetadata) {
      await refreshObjectMetadata(tabId).catch(() => null);
    } else {
      await args.refreshFallback();
    }

    for (const snapshot of created) {
      const label = objectKindSingular(snapshot.kind);
      showToast(`Created ${label} "${snapshot.form.name}".`, {
        tone: "success",
        durationMs: 8_000,
        action: refreshObjectMetadata
          ? {
              label: "Open",
              onClick: () =>
                openCreatedObject({
                  screenTabId: tabId,
                  connectionId,
                  kind: snapshot.kind,
                  schema: snapshot.form.schema,
                  name: snapshot.form.name,
                  refresh: refreshObjectMetadata,
                }),
            }
          : undefined,
      });
    }
    const saved = entries.length - created.length;
    if (saved > 0) {
      showToast(saved === 1 ? "Object saved." : "Objects saved.", {
        tone: "success",
      });
    }
  } finally {
    for (const key of createKeys) drafts().setSaving(tabId, key, false);
    objectSaveRuns.delete(tabId);
  }
}

/** Discard a tab's object drafts, closed ones too: drop creates, revert edits. */
export function discardObjectDraftsForTab(tabId: string) {
  const store = useObjectDraftStore.getState();
  const closing = new Set<string>();
  for (const draft of objectDraftsForTab(tabId)) {
    if (draft.saving) continue;
    if (draft.mode === "create") {
      store.remove(tabId, draft.key);
      closing.add(draft.key);
    } else if (hasPendingWork(draft)) {
      store.revert(tabId, draft.key);
    }
  }
  closeDraftWindows(tabId, closing);
}
