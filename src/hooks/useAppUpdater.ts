import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import packageJson from "@root/package.json";
import { getVersion } from "@tauri-apps/api/app";
import { trackEssentialEvent } from "src/lib/analytics";
import { useLicenseStore } from "src/stores/license";
import {
  checkForRuntimeUpdate,
  installRuntimeUpdate,
  isTauriRuntime,
  type RuntimeUpdate,
} from "src/lib/updater/runtimeUpdater";

export function useAppUpdater() {
  const licenseState = useLicenseStore((s) => s.state);

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

  const canInstallUpdate = useMemo(() => {
    const normalizedStatus = String(licenseState?.status ?? "")
      .trim()
      .toLowerCase();
    if (normalizedStatus === "active") {
      return true;
    }

    if (normalizedStatus === "expired") {
      return false;
    }

    const trialExpiresAt = Number(licenseState?.trial_expires_at ?? 0);
    if (Number.isFinite(trialExpiresAt) && trialExpiresAt > 0) {
      return trialExpiresAt > Date.now();
    }

    return true;
  }, [licenseState?.status, licenseState?.trial_expires_at]);

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
    isInstallingUpdate: isUpdating,
    canInstallUpdate,
    installUpdate,
  };
}
