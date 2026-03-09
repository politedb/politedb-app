import { useCallback, useEffect, useState } from "preact/hooks";
import { profileConnect } from "src/lib/tauri/profile";
import { ProfileTab, useScreenStore } from "src/stores/screen";

export function useEnsureRuntimeConnection(activeTab?: ProfileTab | null) {
  const { updateTab } = useScreenStore();

  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!activeTab?.profileId) return;

    // already connected
    if (activeTab.runtimeConnectionId) return;

    let canceled = false;
    setConnecting(true);

    void (async () => {
      try {
        const res = await profileConnect(activeTab.profileId);
        setError(null);
        if (canceled) return;
        updateTab(activeTab.id, { runtimeConnectionId: res.connection.id });
      } catch (e: any) {
        setError(e?.message ? String(e.message) : String(e));
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
    updateTab,
  ]);

  const reload = useCallback(async () => {
    if (!activeTab?.profileId) return null;
    if (activeTab.runtimeConnectionId) return activeTab.runtimeConnectionId;
    setConnecting(true);
    try {
      const res = await profileConnect(activeTab.profileId);
      setError(null);
      updateTab(activeTab.id, { runtimeConnectionId: res.connection.id });
      return res.connection.id;
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
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
