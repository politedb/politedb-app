import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { errorCode, trackEvent } from "src/lib/analytics";
import {
  connectProfileOnce,
  resolveTabRuntimeConnectionId,
} from "src/lib/runtimeConnection";
import { useConnectionStore } from "src/stores/connection";
import {
  recordConnectionSessionFailed,
  recordConnectionSessionOpened,
} from "src/stores/connectionLog";
import { ProfileTab, useScreenStore } from "src/stores/screen";

function readResolvedConnectionId(
  activeTab: ProfileTab,
  activeProfileScreen: string
): string | undefined {
  return resolveTabRuntimeConnectionId({
    tabRuntimeConnectionId: activeTab.runtimeConnectionId,
    activeProfileScreen,
    tableDataMap: useConnectionStore.getState().tableDataMap,
  });
}

export function useEnsureRuntimeConnection(activeTab?: ProfileTab | null) {
  const { updateTab, activeProfileScreen } = useScreenStore();

  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Bumped whenever the screen moves to another tab/profile (and on unmount), so a
  // reload started for the previous one never applies its result here.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [activeTab?.id, activeTab?.profileId]);

  useEffect(() => {
    if (!activeTab?.profileId || activeProfileScreen === "main") return;

    const resolvedConnectionId = readResolvedConnectionId(
      activeTab,
      activeProfileScreen
    );

    // already connected — clear any stale error from a previous failed attempt
    if (resolvedConnectionId) {
      setError(null);
      setConnecting(false);
      if (!activeTab.runtimeConnectionId) {
        updateTab(activeTab.id, {
          runtimeConnectionId: resolvedConnectionId,
        });
      }
      return;
    }

    let canceled = false;
    setConnecting(true);

    void (async () => {
      const startedAt = Date.now();
      const tabId = activeTab.id;
      const profileId = activeTab.profileId;
      try {
        const connectionId = await connectProfileOnce(profileId);
        setError(null);
        if (canceled) return;

        const latestTab = useScreenStore
          .getState()
          .profileTabs.find((t) => t.id === tabId);
        if (latestTab?.runtimeConnectionId) return;

        updateTab(tabId, { runtimeConnectionId: connectionId });
        void recordConnectionSessionOpened(activeTab);
        trackEvent("runtime_connection_opened", {
          engine: activeTab.engine,
          source: "auto_restore",
          duration_ms: Date.now() - startedAt,
        });
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        setError(msg);
        if (!canceled) {
          void recordConnectionSessionFailed(activeTab, msg);
        }
        trackEvent("runtime_connection_open_error", {
          engine: activeTab.engine,
          source: "auto_restore",
          duration_ms: Date.now() - startedAt,
          error: errorCode(msg),
        });
      } finally {
        if (!canceled) setConnecting(false);
      }
    })();

    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab?.id,
    activeTab?.profileId,
    activeTab?.runtimeConnectionId,
    activeTab?.engine,
    activeProfileScreen,
    updateTab,
  ]);

  const reload = useCallback(async () => {
    if (!activeTab?.profileId || activeProfileScreen === "main") return null;

    const resolvedConnectionId = readResolvedConnectionId(
      activeTab,
      activeProfileScreen
    );
    if (resolvedConnectionId) return resolvedConnectionId;

    const startedFor = generation.current;
    const tab = activeTab;
    const profileId = activeTab.profileId;
    // Screen state (error, busy) belongs to whatever tab is shown now; results of a
    // reload started for another tab only touch that tab, and only if it still exists.
    const sameScreen = () => generation.current === startedFor;
    const tabExists = () =>
      useScreenStore.getState().profileTabs.some((t) => t.id === tab.id);

    setConnecting(true);
    const startedAt = Date.now();
    try {
      const connectionId = await connectProfileOnce(profileId);
      if (sameScreen()) setError(null);
      if (tabExists()) {
        updateTab(tab.id, { runtimeConnectionId: connectionId });
        void recordConnectionSessionOpened(tab);
        trackEvent("runtime_connection_opened", {
          engine: tab.engine,
          source: "manual_reload",
          duration_ms: Date.now() - startedAt,
        });
      }
      return connectionId;
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      if (sameScreen()) setError(msg);
      if (tabExists()) {
        void recordConnectionSessionFailed(tab, msg);
        trackEvent("runtime_connection_open_error", {
          engine: tab.engine,
          source: "manual_reload",
          duration_ms: Date.now() - startedAt,
          error: errorCode(msg),
        });
      }
    } finally {
      if (sameScreen()) setConnecting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab?.id,
    activeTab?.profileId,
    activeTab?.runtimeConnectionId,
    activeTab?.engine,
    activeProfileScreen,
    updateTab,
  ]);

  return { connecting, error, setError, reload };
}
