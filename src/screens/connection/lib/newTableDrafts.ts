import type { NewTableDataState } from "src/stores/connection";
import type { TableWindow } from "src/types";

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
