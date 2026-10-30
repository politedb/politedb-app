import { useCallback, useEffect, useState } from "preact/hooks";
import { trackEvent } from "src/lib/analytics";
import {
  connectTabOnce,
  resolveTabRuntimeConnectionId,
  runtimeServesTab,
  TAB_CONNECT_SUPERSEDED,
} from "src/lib/runtimeConnection";
import { useConnectionStore } from "src/stores/connection";
import {
  recordConnectionSessionFailed,
  recordConnectionSessionOpened,
} from "src/stores/connectionLog";
import { ProfileTab, useScreenStore } from "src/stores/screen";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";

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
    // An unknown tab never connects (R7); the screen says why.
    if (activeTab.target?.kind === "unknown" || !activeTab.target) {
      setConnecting(false);
      return;
    }

    let canceled = false;
    setConnecting(true);

    void (async () => {
      const startedAt = Date.now();
      const tabId = activeTab.id;
      try {
        // Installs it on the tab itself (or removes it if superseded).
        await connectTabOnce(tabId);
        setError(null);
        if (canceled) return;
        void recordConnectionSessionOpened(activeTab);
        trackEvent("runtime_connection_opened", {
          engine: activeTab.engine,
          source: "auto_restore",
          duration_ms: Date.now() - startedAt,
        });
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        if (msg === TAB_CONNECT_SUPERSEDED) return;
        setError(msg);
        if (!canceled) {
          void recordConnectionSessionFailed(activeTab, msg);
        }
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
    // A refused (stale) connection, or one not opened on this tab's target
    // by this tab, is replaced; a valid one is kept.
    const replace =
      !!resolvedConnectionId &&
      (!!useRuntimeTargetsStore.getState().refused[resolvedConnectionId] ||
        !runtimeServesTab(activeTab.id, resolvedConnectionId));
    if (resolvedConnectionId && !replace) return resolvedConnectionId;

    setConnecting(true);
    const startedAt = Date.now();
    try {
      const connectionId = await connectTabOnce(activeTab.id, {
        force: replace,
      });
      setError(null);
      void recordConnectionSessionOpened(activeTab);
      trackEvent("runtime_connection_opened", {
        engine: activeTab.engine,
        source: "manual_reload",
        duration_ms: Date.now() - startedAt,
      });
      return connectionId;
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setError(msg);
      void recordConnectionSessionFailed(activeTab, msg);
      trackEvent("runtime_connection_open_error", {
        engine: activeTab.engine,
        source: "manual_reload",
        duration_ms: Date.now() - startedAt,
        error: msg.slice(0, 240),
      });
    } finally {
      setConnecting(false);
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
