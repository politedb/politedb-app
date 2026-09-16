import { useCallback, useEffect, useState } from "preact/hooks";
import packageJson from "@root/package.json";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { trackEssentialEvent } from "src/lib/analytics";
import {
  checkForRuntimeUpdate,
  installRuntimeUpdate,
  isTauriRuntime,
  type RuntimeUpdate,
} from "src/lib/updater/runtimeUpdater";

let trackedUpdateVersion: string | null = null;

function trackUpdateIfNew(currentVersion: string, update: RuntimeUpdate) {
  if (trackedUpdateVersion === update.version) return;
  trackedUpdateVersion = update.version;
  trackEssentialEvent("app_update_available", {
    current_version: currentVersion,
    next_version: update.version,
  });
}

export function useAppUpdater() {
  const [appVersion, setAppVersion] = useState<string>(packageJson.version);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [pendingUpdate, setPendingUpdate] = useState<RuntimeUpdate | null>(
    null
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let isMounted = true;

    getVersion()
      .then((version) => {
        if (isMounted) setAppVersion(version);
      })
      .catch(() => {
        // Keep package.json version as fallback.
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let unlistenFocus: (() => void) | undefined;

    const runCheck = async () => {
      const update = await checkForRuntimeUpdate();
      if (!isMounted) return;
      setPendingUpdate(update);
      if (update) trackUpdateIfNew(appVersion, update);
    };

    void runCheck();

    const onWindowFocus = () => {
      void runCheck();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void runCheck();
    };

    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibility);

    if (isTauriRuntime()) {
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused) void runCheck();
        })
        .then((unlisten) => {
          if (!isMounted) {
            unlisten();
            return;
          }
          unlistenFocus = unlisten;
        })
        .catch(() => {
          // Browser focus / visibility listeners still cover the home screen.
        });
    }

    return () => {
      isMounted = false;
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      unlistenFocus?.();
    };
  }, [appVersion]);

  const canInstallUpdate = true;

  const installUpdate = useCallback(async () => {
    if (!pendingUpdate || isUpdating || !canInstallUpdate) return;
    setIsUpdating(true);
    try {
      trackEssentialEvent("app_update_install_started", {
        current_version: appVersion,
        next_version: pendingUpdate.version,
      });
      await installRuntimeUpdate(pendingUpdate);
    } finally {
      setIsUpdating(false);
    }
  }, [pendingUpdate, isUpdating, canInstallUpdate, appVersion]);

  return {
    appVersion,
    updateAvailable: !!pendingUpdate && canInstallUpdate,
    updateVersion: pendingUpdate?.version ?? null,
    isUpdating,
    canInstallUpdate,
    installUpdate,
  };
}
