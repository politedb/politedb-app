import type { ResolvedTheme } from "src/lib/theme";

export interface TableCellBackgroundState {
  dirty: boolean;
  deleted: boolean;
  newRow: boolean;
  selected: boolean;
  focused: boolean;
}

export type TableCanvasPalette = {
  background: string;
  zebra: string;
  grid: string;
  text: string;
  textMuted: string;
  textSelectedUnfocused: string;
  activeStrokeFocused: string;
  activeStrokeUnfocused: string;
  selected: string;
  selectedUnfocused: string;
  deleted: string;
  newRow: string;
  dirty: string;
};

export const TABLE_CANVAS_PALETTE: Record<ResolvedTheme, TableCanvasPalette> = {
  light: {
    background: "#ffffff",
    zebra: "#fafafa",
    grid: "#e5e5e5",
    text: "#111827",
    textMuted: "#9ca3af",
    textSelectedUnfocused: "#6b7280",
    activeStrokeFocused: "#0000ff",
    activeStrokeUnfocused: "#9ca3af",
    selected: "#bedbff",
    selectedUnfocused: "#dbdbdb",
    deleted: "#fbbdbd",
    newRow: "#dcfce7",
    dirty: "#fdf0bb",
  },
  dark: {
    background: "#1c1c1c",
    zebra: "#141414",
    grid: "#2e2e2e",
    text: "#e8e8e8",
    textMuted: "#a3a3a3",
    textSelectedUnfocused: "#a3a3a3",
    activeStrokeFocused: "#60a5fa",
    activeStrokeUnfocused: "#737373",
    selected: "#264f78",
    selectedUnfocused: "#2e2e2e",
    deleted: "#7f1d1d",
    newRow: "#14532d",
    dirty: "#713f12",
  },
};

export function getTableCanvasPalette(
  theme: ResolvedTheme
): TableCanvasPalette {
  return TABLE_CANVAS_PALETTE[theme];
}

export function tableCellBackground(
  { dirty, deleted, newRow, selected, focused }: TableCellBackgroundState,
  theme: ResolvedTheme = "light"
): string | null {
  const palette = getTableCanvasPalette(theme);
  if (selected) return focused ? palette.selected : palette.selectedUnfocused;
  if (deleted) return palette.deleted;
  if (newRow) return palette.newRow;
  if (dirty) return palette.dirty;
  return null;
}
