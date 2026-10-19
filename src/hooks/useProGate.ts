import { useCallback, useEffect, useState } from "preact/hooks";
import { hasProAccess, type ProFeature } from "src/lib/license/proAccess";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";

/**
 * Pro access for UI entry points. `requirePro(feature)` returns true when the action may
 * run; otherwise it opens the upgrade dialog for that feature and returns false.
 */
export function useProGate() {
  // Subscribe with Preact hooks directly so components stay testable without the
  // React adapter zustand's hook would pull in.
  const [hasPro, setHasPro] = useState(() =>
    hasProAccess(useLicenseStore.getState().state)
  );

  useEffect(() => {
    setHasPro(hasProAccess(useLicenseStore.getState().state));
    return useLicenseStore.subscribe((store) =>
      setHasPro(hasProAccess(store.state))
    );
  }, []);

  const requirePro = useCallback(
    (feature: ProFeature) => {
      if (hasPro) return true;
      useProUpgradeStore.getState().open(feature);
      return false;
    },
    [hasPro]
  );

  return { hasPro, requirePro };
}
