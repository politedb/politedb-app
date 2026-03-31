import { useCallback, useEffect, useState } from "preact/hooks";
import packageJson from "@root/package.json";
import { getVersion } from "@tauri-apps/api/app";
import { trackEssentialEvent } from "src/lib/analytics";
import {
  checkForRuntimeUpdate,
  installRuntimeUpdate,
  isTauriRuntime,
  type RuntimeUpdate,
} from "src/lib/updater/runtimeUpdater";

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
    (async () => {
      const update = await checkForRuntimeUpdate();
      if (update) {
        setPendingUpdate(update);
        trackEssentialEvent("app_update_available", {
          current_version: appVersion,
          next_version: update.version,
        });
      }
    })();
  }, [appVersion]);

  const installUpdate = useCallback(async () => {
    if (!pendingUpdate || isUpdating) return;
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
  }, [pendingUpdate, isUpdating, appVersion]);

  return {
    appVersion,
    updateAvailable: !!pendingUpdate,
    updateVersion: pendingUpdate?.version ?? null,
    installUpdate,
    isInstallingUpdate: isUpdating,
  };
}
