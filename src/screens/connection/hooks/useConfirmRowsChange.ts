import { useCallback } from "preact/hooks";
import { hasRowPositionPatches } from "src/lib/patches/rowPositionPatches";
import { confirmDialog } from "src/lib/system-dialog";
import { useConnectionStore } from "src/stores/connection";

/**
 * Asks before other rows take the positions of unsaved row edits and deletions
 * in the table windows matching `matches` (see rowPositionPatches). Resolves true
 * when none has such changes or the user discarded them, false to keep
 * everything as it is. Saving targets the recorded rows either way; this keeps
 * the grid's change markers on the rows they belong to.
 */
export async function confirmRowsChangeIn(
  profileId: string,
  matches: (tableWindow: {
    id: string;
    table: { schema: string; name: string };
  }) => boolean
) {
  const windows = useConnectionStore.getState().dataPatchMap[profileId] ?? {};
  const dirty = Object.entries(windows)
    .filter(
      ([, win]) =>
        win?.tableWindow &&
        matches(win.tableWindow) &&
        hasRowPositionPatches(win.patches)
    )
    .map(([windowId]) => windowId);
  if (dirty.length === 0) return true;
  const ok = await confirmDialog(
    "Edited and deleted rows are not saved yet. Showing other rows discards those changes. Save first to keep them.",
    {
      title: "Discard unsaved row changes?",
      kind: "warning",
      okLabel: "Discard changes",
      cancelLabel: "Cancel",
    }
  );
  if (!ok) return false;
  const store = useConnectionStore.getState();
  for (const windowId of dirty) {
    store.discardRowPositionPatches(profileId, windowId);
  }
  return true;
}

/**
 * confirmRowsChangeIn for one table: all its windows share the loaded rows, so
 * any of them may hold row changes for these positions.
 */
export function useConfirmRowsChange(
  profileId: string,
  schema: string,
  name: string
) {
  return useCallback(
    () =>
      confirmRowsChangeIn(
        profileId,
        (tableWindow) =>
          tableWindow.table.schema === schema && tableWindow.table.name === name
      ),
    [profileId, schema, name]
  );
}
