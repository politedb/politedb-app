/** Row selection background/text classes for focused vs unfocused table state. */
export const EDITABLE_TABLE_CELL_CLASS = "table-cell-editor";
export const ACTIVE_TABLE_CELL_CLASS = "table-cell-active";

export function selectionRowClass(
  selected: boolean,
  focused: boolean
): string | undefined {
  if (!selected) return undefined;
  return focused ? "bg-selected!" : "bg-selected-unfocused! text-neutral-500!";
}

/** Mutation background class shared by DOM table implementations. */
export function tableMutationRowClass(
  deleted: boolean,
  newRow: boolean
): string {
  if (deleted) return "bg-deleted!";
  if (newRow) return "bg-new!";
  return "";
}
