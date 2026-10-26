import type {
  DatabaseObjectKind,
  DatabaseObjectManagerWindow,
} from "src/types";

/**
 * One function/procedure/trigger window per draft: its id is this prefix
 * plus the draft key, so a window and its draft always match.
 *   edit:   "obj:" + object id (stable across close/reopen)
 *   create: "new:" + kind + random part (never changes with the form)
 */
const WINDOW_PREFIX = "db-object-manager:";

export function editDraftKey(objectId: string): string {
  return `obj:${objectId}`;
}

export function newCreateDraftKey(kind: DatabaseObjectKind): string {
  return `new:${kind}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function windowIdForDraftKey(key: string): string {
  return `${WINDOW_PREFIX}${key}`;
}

/**
 * The draft a window edits. A window bound to an object edits that object
 * (also for windows saved by earlier versions with a "new:" id).
 */
export function draftKeyForWindow(
  win: Pick<DatabaseObjectManagerWindow, "id" | "initialObjectId">
): string {
  const objectId = (win.initialObjectId ?? "").trim();
  if (objectId) return editDraftKey(objectId);
  return win.id.startsWith(WINDOW_PREFIX)
    ? win.id.slice(WINDOW_PREFIX.length)
    : win.id;
}

export function isCreateDraftKey(key: string): boolean {
  return key.startsWith("new:");
}
