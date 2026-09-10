/** Row selection background/text classes for focused vs unfocused table state. */
export const EDITABLE_TABLE_CELL_CLASS = "table-cell-editor";

export function selectionRowClass(
  selected: boolean,
  focused: boolean
): string | undefined {
  if (!selected) return undefined;
  return focused ? "bg-selected!" : "bg-selected-unfocused! text-neutral-500!";
}
