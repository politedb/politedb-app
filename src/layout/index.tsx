import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { ConnectionScreen } from "src/screens/connection/ConnectionScreen";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useLicenseStore } from "src/stores/license";
import { TrialExpiredOverlay } from "src/screens/main/TrialExpiredOverlay";
import { LicenseDialog } from "src/components/modal/LicenseDialog";

const LICENSE_VALIDATION_GRACE_MS = 60 * 60 * 1000;

export function MainLayout() {
  const { activeProfileScreen, setActiveProfileScreen, profileTabs } =
    useScreenStore();
  const loadLicense = useLicenseStore((s) => s.load);
  const licenseState = useLicenseStore((s) => s.state);
  const licenseLoaded = useLicenseStore((s) => s.loaded);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const isTab = !!activeProfileScreen && activeProfileScreen.startsWith("tab-");
  const activeTab = isTab
    ? profileTabs.find((t) => t.id === activeProfileScreen)
    : null;

  useEffect(() => {
    if (isTab && !activeTab) setActiveProfileScreen("main");
  }, [isTab, activeTab, setActiveProfileScreen]);

  useEffect(() => {
    void loadLicense();
  }, [loadLicense]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const isLicenseActive =
    String(licenseState?.status ?? "").toLowerCase() === "active";
  const hasActivationData = Boolean(
    licenseState?.license_key || licenseState?.activation_token
  );
  const isValidationStale = useMemo(() => {
    if (!isLicenseActive || !hasActivationData) return false;
    const lastValidatedAt = Number(licenseState?.last_validated_at ?? 0);
    if (!Number.isFinite(lastValidatedAt) || lastValidatedAt <= 0) return true;
    return now - lastValidatedAt > LICENSE_VALIDATION_GRACE_MS;
  }, [
    hasActivationData,
    isLicenseActive,
    licenseState?.last_validated_at,
    now,
  ]);
  const isTrialExpired = useMemo(() => {
    const expiresAt = Number(licenseState?.trial_expires_at ?? 0);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
  }, [licenseState?.trial_expires_at, now]);
  const isAppLocked =
    licenseLoaded &&
    (isValidationStale || (!isLicenseActive && isTrialExpired));

  return (
    <div class="app-header flex h-screen flex-col overflow-hidden rounded-t-xl bg-neutral-50">
      <AppHeader
        activeTabId={activeProfileScreen}
        activeNav={activeProfileScreen || "main"}
        onNavChange={setActiveProfileScreen}
      />
      <div class="flex-1 overflow-hidden bg-white">
        {activeProfileScreen === "main" && <MainScreen />}
        {activeTab && <ConnectionScreen />}
      </div>
      {isAppLocked ? (
        <>
          <TrialExpiredOverlay
            state={licenseState}
            onOpenLicense={() => setLicenseOpen(true)}
          />
          <LicenseDialog
            open={licenseOpen}
            onClose={() => setLicenseOpen(false)}
          />
        </>
      ) : null}
    </div>
  );
}
