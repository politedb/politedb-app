import type { TableWindow } from "src/types";

/**
 * MenuBar Refresh / Mod+R should reload only the focused table pane.
 * Other open table tabs stay as-is (schema metadata may still refresh separately).
 * Draft "new table" panes have no server rows to reload.
 */
export function tablesToReloadOnManualRefresh(
  activeTableWindow: TableWindow | undefined
): TableWindow[] {
  if (!activeTableWindow) return [];
  if (activeTableWindow.table?.new) return [];
  return [activeTableWindow];
}
