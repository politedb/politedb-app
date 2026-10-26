import type {
  DatabaseEngine,
  DatabaseObjectItem,
  DatabaseObjectKind,
  DatabaseObjectManagerWindow,
} from "src/types";
import {
  buildCreateDatabaseObjectTemplate,
  nextUniqueObjectDraftName,
  objectKindSingular,
} from "src/lib/databaseObjects";
import type { MetadataRefreshOutcome } from "src/hooks/useDatabaseMetadata";
import { showToast } from "src/stores/toast";
import {
  draftKeyForWindow,
  editDraftKey,
  newCreateDraftKey,
  windowIdForDraftKey,
} from "src/lib/objectDraftKey";
import { useScreenStore } from "src/stores/screen";
import {
  objectDraftsForTab,
  useObjectDraftStore,
  type ObjectDraftForm,
} from "src/stores/objectDrafts";

/**
 * Opening function/procedure/trigger windows from the live stores (not a
 * captured window list), so callers that run later (a toast action, after
 * an await) see the current windows and drafts of their screen tab.
 */

function focusOrAdd(tabId: string, win: DatabaseObjectManagerWindow): string {
  const screen = useScreenStore.getState();
  const key = draftKeyForWindow(win);
  const existing = (screen.openWindows[tabId] ?? []).find(
    (w) => w.type === "db-object-manager" && draftKeyForWindow(w) === key
  );
  if (existing) {
    screen.setActiveWindowId(tabId, existing.id);
    return existing.id;
  }
  screen.addWindow(tabId, win);
  screen.setActiveWindowId(tabId, win.id);
  return win.id;
}

function screenTabExists(tabId: string): boolean {
  return useScreenStore.getState().profileTabs.some((t) => t.id === tabId);
}

/** Open (or focus) the editor of an existing object; never touches a draft. */
export function openObjectInScreenTab(
  tabId: string,
  object: DatabaseObjectItem
): string | null {
  if (!screenTabExists(tabId)) return null;
  const key = editDraftKey(object.id);
  useObjectDraftStore.getState().ensureEditDraft(tabId, key, object);
  return focusOrAdd(tabId, {
    id: windowIdForDraftKey(key),
    type: "db-object-manager",
    title: object.name,
    initialKind: object.kind,
    initialObjectId: object.id,
  });
}

/** Reopen a draft by its key (a closed create, or an edit). */
export function openObjectDraftInScreenTab(
  tabId: string,
  key: string
): string | null {
  if (!screenTabExists(tabId)) return null;
  const draft = useObjectDraftStore.getState().drafts[tabId]?.[key];
  if (!draft) return null;
  return focusOrAdd(tabId, {
    id: windowIdForDraftKey(key),
    type: "db-object-manager",
    title: draft.form.name || draft.item?.name,
    initialKind: draft.kind,
    initialObjectId: draft.mode === "edit" ? draft.item?.id : "",
  });
}

/** The name, schema, table and template a new object starts with. */
export function newObjectDraftInit(args: {
  tabId: string;
  engine: DatabaseEngine;
  kind: DatabaseObjectKind;
  schema: string;
  tables: { schema: string; name: string }[];
  existingNames: string[];
}): { kind: DatabaseObjectKind; form: ObjectDraftForm; sql: string } {
  const taken = [
    ...args.existingNames,
    ...objectDraftsForTab(args.tabId)
      .filter((d) => d.mode === "create")
      .map((d) => d.form.name),
  ];
  const name = nextUniqueObjectDraftName(args.kind, taken);
  const tableName =
    args.tables.find((table) => table.schema === args.schema)?.name ?? "";
  const form = { schema: args.schema, name, tableName };
  const sql = buildCreateDatabaseObjectTemplate({
    engine: args.engine,
    kind: args.kind,
    ...form,
  });
  return { kind: args.kind, form, sql };
}

/** Start a new object: the draft exists before its window renders. */
export function openNewObjectDraftInScreenTab(
  tabId: string,
  init: { kind: DatabaseObjectKind; form: ObjectDraftForm; sql: string }
): string | null {
  if (!screenTabExists(tabId)) return null;
  const key = newCreateDraftKey(init.kind);
  useObjectDraftStore.getState().ensureCreateDraft(tabId, key, init);
  return openObjectDraftInScreenTab(tabId, key);
}

/** The metadata cache key of a connection screen tab. */
export function metaKeyForTab(tab: { id: string; engine?: string }): string {
  return `${tab.engine ?? "postgres"}:${tab.id}`;
}

export type ObjectMetadataRefresh = (
  screenTabId: string
) => Promise<MetadataRefreshOutcome>;

/**
 * The toast's Open action for a just-created object: a navigation started
 * by that click, against live state. It opens the object only if the
 * screen tab still exists on the same connection before and after a fresh
 * metadata refresh (same epoch: not closed, reset or reconnected meanwhile)
 * and exactly one object has that kind, schema and name; otherwise it
 * points to the sidebar. It never targets another screen tab.
 */
export async function openCreatedObject(args: {
  screenTabId: string;
  connectionId: string;
  kind: DatabaseObjectKind;
  schema: string;
  name: string;
  refresh: ObjectMetadataRefresh;
}): Promise<void> {
  const hint = () =>
    showToast(
      `Open the ${objectKindSingular(args.kind)} from the Objects sidebar.`,
      { tone: "info" }
    );
  const liveTab = () =>
    useScreenStore
      .getState()
      .profileTabs.find((t) => t.id === args.screenTabId);

  const before = liveTab();
  if (!before || before.runtimeConnectionId !== args.connectionId) {
    hint();
    return;
  }
  const epoch = useScreenStore.getState().tabEpoch[args.screenTabId] ?? 0;

  let outcome: MetadataRefreshOutcome;
  try {
    outcome = await args.refresh(args.screenTabId);
  } catch {
    hint();
    return;
  }

  // Revalidate after the await; nothing below awaits before opening.
  const after = liveTab();
  const valid =
    outcome.ok &&
    !!after &&
    after.runtimeConnectionId === args.connectionId &&
    outcome.connectionId === args.connectionId &&
    outcome.metaKey === metaKeyForTab(after) &&
    (useScreenStore.getState().tabEpoch[args.screenTabId] ?? 0) === epoch;
  if (!valid || !outcome.ok) {
    hint();
    return;
  }
  const matches = outcome.objects.filter(
    (item) =>
      item.kind === args.kind &&
      item.schema === args.schema &&
      item.name === args.name
  );
  if (matches.length !== 1) {
    hint();
    return;
  }
  openObjectInScreenTab(args.screenTabId, matches[0]!);
  useScreenStore.getState().setActiveProfileScreen(args.screenTabId);
}
