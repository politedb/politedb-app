import type { NewTableDataState } from "src/stores/connection";
import type { ObjectSaveNotice } from "src/lib/objectEditorDraftCache";
import type { OpenWindow, TableItem, TableWindow } from "src/types";
import { matchesSidebarSearch } from "./sidebarSearch";

/*
 * A new-table draft is keyed by its window id; its window may be closed
 * while the draft stays listed in the sidebar. Its identity (schema and the
 * window's table name) is recorded in the draft itself and never guessed by
 * splitting the window id, which is ambiguous once a name contains a dot.
 */

export const UNRESOLVED_DRAFT_REASON =
  "it was drafted in an earlier version and its schema cannot be determined; discard it from the sidebar (Drop...) and create it again";

/**
 * The window of the draft stored under `windowId` (open or not), or null
 * when its identity cannot be told: a draft saved before identities were
 * recorded whose window id does not split unambiguously.
 */
export function newTableDraftWindow(
  windowId: string,
  draft: Pick<NewTableDataState, "schema" | "windowName"> | null | undefined
): TableWindow | null {
  if (draft?.schema && draft.windowName) {
    return {
      id: windowId,
      type: "table",
      table: { schema: draft.schema, name: draft.windowName, new: true },
    } as TableWindow;
  }
  if (!windowId.startsWith("table:")) return null;
  const parts = windowId.slice("table:".length).split(".");
  // Only `schema.name` with no other dot is unambiguous.
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return {
    id: windowId,
    type: "table",
    table: { schema: parts[0], name: parts[1], new: true },
  } as TableWindow;
}

/**
 * The tab's drafts a save cannot run (identity unknown, window closed), as
 * the save review lists them. One collection for the save itself and its
 * review.
 */
export function unresolvedNewTableDrafts(
  drafts: Record<string, Partial<NewTableDataState> | undefined>,
  openWindows: readonly { id: string }[]
): { windowId: string; name: string }[] {
  const open = new Set(openWindows.map((w) => w.id));
  return Object.entries(drafts)
    .filter(
      ([windowId, draft]) =>
        !open.has(windowId) && !newTableDraftWindow(windowId, draft)
    )
    .map(([windowId, draft]) => ({
      windowId,
      name: draft?.tableName?.trim() || windowId,
    }));
}

export function unresolvedNewTableNotices(
  drafts: Record<string, Partial<NewTableDataState> | undefined>,
  openWindows: readonly { id: string }[]
): ObjectSaveNotice[] {
  return unresolvedNewTableDrafts(drafts, openWindows).map((draft) => ({
    kind: "skipped",
    key: draft.windowId,
    name: draft.name,
    reason: UNRESOLVED_DRAFT_REASON,
  }));
}

/**
 * The sidebar's tables: the schema's own, then new-table drafts with an
 * open window, then drafts whose window is closed (under the name being
 * typed). A draft whose identity cannot be told is always its own item,
 * whatever its name, so it can be discarded.
 */
export function mergeSidebarTables(args: {
  tables: TableItem[];
  windows: OpenWindow[];
  drafts: Record<string, Partial<NewTableDataState> | undefined>;
  activeSchema: string;
  search: string;
}): TableItem[] {
  const base = [...args.tables];
  const draftTables = args.windows
    .filter(
      (w): w is Extract<OpenWindow, { type: "table" }> =>
        w.type === "table" && !!w.table?.new
    )
    .map((w) => w.table)
    .filter((t) => !args.activeSchema || t.schema === args.activeSchema)
    .filter((t) =>
      matchesSidebarSearch(
        t,
        args.search.trim().toLowerCase(),
        args.activeSchema
      )
    );

  // Drafts whose window is closed: listed under the name being typed, and
  // reopened in their own window (never as a second draft).
  const openWindowIds = new Set(args.windows.map((w) => w.id));
  const persistedDraftTables = Object.entries(args.drafts)
    .map(([windowId, data]) => {
      if (openWindowIds.has(windowId)) return null;
      const rawName = data?.tableName?.trim() ?? "";
      const window = newTableDraftWindow(windowId, data);
      // One whose schema cannot be told is always listed, on its own and
      // under the schema being shown, so it can be discarded.
      if (!window) {
        return {
          schema: args.activeSchema,
          name: `${rawName || "untitled"} (cannot be saved)`,
          new: true,
          draftWindowId: windowId,
          unresolvedDraft: true,
        } as TableItem;
      }
      if (!rawName) return null;
      return {
        schema: window.table.schema,
        name: rawName,
        new: true,
        draftWindowId: windowId,
      } as TableItem;
    })
    .filter((t): t is TableItem => !!t)
    .filter((t) => !args.activeSchema || t.schema === args.activeSchema)
    .filter((t) =>
      matchesSidebarSearch(
        t,
        args.search.trim().toLowerCase(),
        args.activeSchema
      )
    );

  for (const draft of [...draftTables, ...persistedDraftTables]) {
    if (
      draft.unresolvedDraft ||
      !base.some((t) => t.schema === draft.schema && t.name === draft.name)
    ) {
      base.push(draft);
    }
  }

  return base;
}
