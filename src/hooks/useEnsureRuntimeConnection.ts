import { useCallback, useEffect, useState } from "preact/hooks";
import { profileConnect } from "src/lib/tauri/profile";
import { useScreenStore } from "src/stores/screen";

export function useEnsureRuntimeConnection(activeTab: any | null) {
  const { updateTab } = useScreenStore();
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
        if (canceled) return;
        updateTab(activeTab.id, { runtimeConnectionId: res.connection.id });
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

  const ensure = useCallback(async () => {
    if (!activeTab?.profileId) return null;
    if (activeTab.runtimeConnectionId) return activeTab.runtimeConnectionId;
    setConnecting(true);
    try {
      const res = await profileConnect(activeTab.profileId);
      updateTab(activeTab.id, { runtimeConnectionId: res.connection.id });
      return res.connection.id;
    } finally {
      setConnecting(false);
    }
  }, [
    activeTab?.id,
    activeTab?.profileId,
    activeTab?.runtimeConnectionId,
    updateTab,
  ]);

  return { connecting, ensure };
}
