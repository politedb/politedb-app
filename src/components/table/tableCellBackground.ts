export interface TableCellBackgroundState {
  dirty: boolean;
  deleted: boolean;
  newRow: boolean;
  selected: boolean;
  focused: boolean;
}

export function tableCellBackground({
  dirty,
  deleted,
  newRow,
  selected,
  focused,
}: TableCellBackgroundState): string | null {
  if (selected) return focused ? "#bedbff" : "#dbdbdb";
  if (deleted) return "#fbbdbd";
  if (newRow) return "#dcfce7";
  if (dirty) return "#fdf0bb";
  return null;
}
