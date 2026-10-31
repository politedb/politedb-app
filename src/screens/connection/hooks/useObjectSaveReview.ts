import { useMemo } from "preact/hooks";
import { unresolvedNewTableNotices } from "../lib/newTableDrafts";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";
import type { DatabaseEngine } from "src/types";
import {
  collectObjectChangeSummary,
  collectObjectSaveNotices,
  collectPendingObjectSql,
  emptyObjectChangeSummary,
} from "src/lib/objectEditorDraftCache";
import { useObjectDraftStore } from "src/stores/objectDrafts";

/**
 * What the save review shows for a screen tab's object drafts: SQL, counts
 * and notices, all from the live drafts. A definition or metadata load
 * that lands while the review is open updates them together, and with
 * them whether Confirm has anything to run.
 */
export function useObjectSaveReview(args: {
  tabId: string;
  engine?: DatabaseEngine;
  open: boolean;
}) {
  const { tabId, engine, open } = args;
  const drafts = useObjectDraftStore((s) => s.drafts[tabId]);
  // New-table drafts a save cannot run are listed with the objects'.
  const tableDrafts = useConnectionStore((s) => s.newTableData[tabId]);
  const windows = useScreenStore((s) => s.openWindows[tabId]);
  return useMemo(() => {
    if (!engine) {
      return {
        objectSql: [],
        objectChangeSummary: emptyObjectChangeSummary(),
        objectSaveNotices: [],
      };
    }
    const scope = { tabId, engine };
    return {
      objectSql: collectPendingObjectSql(scope),
      objectChangeSummary: collectObjectChangeSummary(scope),
      objectSaveNotices: open
        ? [
            ...collectObjectSaveNotices(scope),
            ...unresolvedNewTableNotices(tableDrafts ?? {}, windows ?? []),
          ]
        : [],
    };
    // `drafts` is the dependency: the collectors read the same store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, tableDrafts, windows, tabId, engine, open]);
}
