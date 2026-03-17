import { useCallback, useEffect, useState } from "preact/hooks";
import packageJson from "@root/package.json";
import { getVersion } from "@tauri-apps/api/app";
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
      if (update) setPendingUpdate(update);
    })();
  }, []);

  const installUpdate = useCallback(async () => {
    if (!pendingUpdate || isUpdating) return;
    setIsUpdating(true);
    try {
      await installRuntimeUpdate(pendingUpdate);
    } finally {
      setIsUpdating(false);
    }
  }, [pendingUpdate, isUpdating]);

  return {
    appVersion,
    updateAvailable: !!pendingUpdate,
    updateVersion: pendingUpdate?.version ?? null,
    installUpdate,
    isInstallingUpdate: isUpdating,
  };
}
