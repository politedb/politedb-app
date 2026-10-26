import { onObjectListLoads } from "src/lib/metadataEvents";
import {
  currentDraftGeneration,
  useObjectDraftStore,
} from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import { metaKeyForTab } from "./objectWindows";

type Started = {
  loadId: number;
  tabId: string;
  connectionId: string;
  epoch: number;
  generation: number;
};

function liveTabFor(metaKey: string) {
  return useScreenStore
    .getState()
    .profileTabs.find((tab) => metaKeyForTab(tab) === metaKey);
}

/**
 * Keeps object drafts in step with every complete metadata load (sidebar
 * refresh, save, toast Open, ...): edits whose object is gone are marked
 * missing (clean ones dropped), and lose the mark when it is listed again.
 * A load only counts for the screen tab it was started for, while that tab
 * keeps the same connection and lifetime (epoch), and only for drafts that
 * already existed when it started. Returns the unsubscribe function.
 */
export function reconcileObjectDraftsOnMetadataLoads(): () => void {
  const started = new Map<string, Started>();
  return onObjectListLoads({
    onStart: ({ loadId, metaKey, connectionId }) => {
      const tab = liveTabFor(metaKey);
      if (!tab || tab.runtimeConnectionId !== connectionId) {
        started.delete(metaKey);
        return;
      }
      started.set(metaKey, {
        loadId,
        tabId: tab.id,
        connectionId,
        epoch: useScreenStore.getState().tabEpoch[tab.id] ?? 0,
        generation: currentDraftGeneration(),
      });
    },
    onLoaded: ({ loadId, metaKey, connectionId, objects }) => {
      const start = started.get(metaKey);
      if (!start || start.loadId !== loadId) return;
      started.delete(metaKey);
      const tab = liveTabFor(metaKey);
      const epoch = useScreenStore.getState().tabEpoch[start.tabId] ?? 0;
      if (
        !tab ||
        tab.id !== start.tabId ||
        tab.runtimeConnectionId !== connectionId ||
        connectionId !== start.connectionId ||
        epoch !== start.epoch
      ) {
        return;
      }
      useObjectDraftStore
        .getState()
        .syncMissing(
          start.tabId,
          new Set(objects.map((item) => item.id)),
          start.generation
        );
    },
  });
}
