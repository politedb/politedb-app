import { useEffect, useRef, useState } from "preact/hooks";
import { loadDatabaseObjectDefinition } from "src/lib/databaseObjects";
import type { DatabaseEngine, DatabaseObjectItem } from "src/types";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";

/**
 * Fetches an object's definition into its edit draft. The draft store owns
 * the SQL: a fetched definition refreshes a clean draft, and only flags a
 * draft with unsaved work (it is never overwritten). A response counts only
 * if the screen tab, draft key, connection, draft generation and revision
 * are still the ones it was requested for and the hook is still mounted.
 */
export function useLoadDbObjectDefinition(args: {
  tabId: string;
  draftKey: string;
  /** The object to load; null while creating or when none is selected. */
  item: DatabaseObjectItem | null;
  engine: DatabaseEngine;
  connectionId?: string;
  /**
   * The edit draft's generation: loads once the draft exists and again
   * after it is reverted (discard) or re-created.
   */
  draftGeneration?: number;
}) {
  const { tabId, draftKey, item, engine, connectionId, draftGeneration } = args;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const itemRef = useRef(item);
  itemRef.current = item;
  const currentRef = useRef({ tabId, draftKey, connectionId });
  currentRef.current = { tabId, draftKey, connectionId };

  const itemId = item?.id ?? null;

  useEffect(() => {
    const target = itemRef.current;
    if (!target) {
      requestSeqRef.current += 1;
      setLoading(false);
      setLoadError(null);
      return;
    }

    const store = useObjectDraftStore.getState();
    const draft = store.drafts[tabId]?.[draftKey];
    if (!draft || draft.mode !== "edit") return;
    const generation = draft.generation;
    const revision = draft.revision;

    if (!target.capability.canReadDefinition) {
      requestSeqRef.current += 1;
      setLoading(false);
      setLoadError(null);
      store.applyDefinition(tabId, draftKey, generation, "", target);
      return;
    }
    // No (admitted) connection yet, e.g. a tab whose target is unknown: the
    // draft stays as it is, never replaced by an empty definition (R5).
    if (!connectionId) {
      requestSeqRef.current += 1;
      setLoading(false);
      setLoadError(null);
      return;
    }

    const seq = ++requestSeqRef.current;
    const epoch = useScreenStore.getState().tabEpoch[tabId] ?? 0;
    setLoading(true);
    setLoadError(null);

    const stillCurrent = () => {
      const now = currentRef.current;
      // The live screen tab, not only the last render: same connection and
      // lifetime as when the request started.
      const screen = useScreenStore.getState();
      const liveTab = screen.profileTabs.find((t) => t.id === tabId);
      return (
        requestSeqRef.current === seq &&
        liveTab?.runtimeConnectionId === connectionId &&
        (screen.tabEpoch[tabId] ?? 0) === epoch &&
        now.tabId === tabId &&
        now.draftKey === draftKey &&
        now.connectionId === connectionId
      );
    };

    void loadDatabaseObjectDefinition({ engine, connectionId, item: target })
      .then((result) => {
        if (!stillCurrent()) return;
        // applyDefinition also ignores a draft discarded, re-created, edited
        // or saved since the request started.
        useObjectDraftStore
          .getState()
          .applyDefinition(
            tabId,
            draftKey,
            generation,
            result.sql,
            target,
            revision
          );
      })
      .catch((err) => {
        if (!stillCurrent()) return;
        // The draft stays as it is: no empty definition is ever applied.
        setLoadError(err instanceof Error ? err.message : String(err ?? ""));
      })
      .finally(() => {
        if (requestSeqRef.current === seq) setLoading(false);
      });

    // Unmounted or retargeted: this response no longer belongs anywhere.
    return () => {
      if (requestSeqRef.current !== seq) return;
      requestSeqRef.current += 1;
      setLoading(false);
    };
  }, [tabId, draftKey, itemId, engine, connectionId, draftGeneration]);

  return { loading, loadError };
}
