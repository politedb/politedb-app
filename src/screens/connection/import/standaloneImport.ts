import { tableKey } from "src/hooks/useLoadTableData";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";

/**
 * Whether importing into this table must go through its table tab: the
 * tab is open, or it holds unsaved row changes (the import reloads rows,
 * so the tab asks about them first). Otherwise the import runs without
 * opening the table.
 */
export function importNeedsTableTab(
  screenTabId: string,
  table: { schema: string; name: string }
): boolean {
  const same = (t: { schema: string; name: string } | undefined) =>
    !!t && t.schema === table.schema && t.name === table.name;
  const windows = useScreenStore.getState().openWindows[screenTabId] ?? [];
  if (windows.some((w) => w.type === "table" && same(w.table))) return true;
  const patches = useConnectionStore.getState().dataPatchMap[screenTabId] ?? {};
  return Object.values(patches).some((entry) => {
    if (!same(entry?.tableWindow?.table)) return false;
    const actions = (entry?.patches ?? {}) as Record<
      string,
      Record<string, Record<string, unknown>> | undefined
    >;
    return Object.values(actions).some((byKey) =>
      Object.values(byKey ?? {}).some(
        (rows) => !!rows && Object.keys(rows).length > 0
      )
    );
  });
}

/**
 * After a sidebar import: drop the table's cached rows in the connection
 * screen tab the import started from, so opening it shows the new rows.
 * A table that is open or holds unsaved edits is left alone (nothing is
 * discarded); refreshing it shows the new rows.
 */
export function forgetImportedTableRows(
  screenTabId: string,
  table: { schema: string; name: string }
) {
  if (importNeedsTableTab(screenTabId, table)) return;
  const key = tableKey(screenTabId, table.schema, table.name);
  const store = useConnectionStore.getState();
  store.clearRows(key);
  store.removeTableDataMap(key);
}
