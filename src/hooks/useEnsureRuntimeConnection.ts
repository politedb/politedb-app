import { useCallback, useEffect, useState } from "preact/hooks";
import { trackEvent } from "src/lib/analytics";
import { connectProfileOnce } from "src/lib/runtimeConnection";
import { ProfileTab, useScreenStore } from "src/stores/screen";

export function useEnsureRuntimeConnection(activeTab?: ProfileTab | null) {
  const { updateTab } = useScreenStore();

  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!activeTab?.profileId) return;

    // already connected — clear any stale error from a previous failed attempt
    if (activeTab.runtimeConnectionId) {
      setError(null);
      setConnecting(false);
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
        trackEvent("runtime_connection_opened", {
          engine: activeTab.engine,
          source: "auto_restore",
          duration_ms: Date.now() - startedAt,
        });
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        setError(msg);
        trackEvent("runtime_connection_open_error", {
          engine: activeTab.engine,
          source: "auto_restore",
          duration_ms: Date.now() - startedAt,
          error: msg.slice(0, 240),
        });
      } finally {
        if (!canceled) setConnecting(false);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [
    activeTab?.id,
    activeTab?.profileId,
    activeTab?.runtimeConnectionId,
    activeTab?.engine,
    updateTab,
  ]);

  const reload = useCallback(async () => {
    if (!activeTab?.profileId) return null;
    if (activeTab.runtimeConnectionId) return activeTab.runtimeConnectionId;
    setConnecting(true);
    const startedAt = Date.now();
    try {
      const connectionId = await connectProfileOnce(activeTab.profileId);
      setError(null);
      updateTab(activeTab.id, { runtimeConnectionId: connectionId });
      trackEvent("runtime_connection_opened", {
        engine: activeTab.engine,
        source: "manual_reload",
        duration_ms: Date.now() - startedAt,
      });
      return connectionId;
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setError(msg);
      trackEvent("runtime_connection_open_error", {
        engine: activeTab.engine,
        source: "manual_reload",
        duration_ms: Date.now() - startedAt,
        error: msg.slice(0, 240),
      });
    } finally {
      setConnecting(false);
    }
  }, [
    activeTab?.id,
    activeTab?.profileId,
    activeTab?.runtimeConnectionId,
    updateTab,
  ]);

  return { connecting, error, setError, reload };
}
