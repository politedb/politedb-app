import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { ConnectionScreen } from "src/screens/connection/ConnectionScreen";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useLicenseStore } from "src/stores/license";
import { TrialExpiredOverlay } from "src/screens/main/TrialExpiredOverlay";
import { LicenseDialog } from "src/components/modal/LicenseDialog";
import { trackScreenView } from "src/lib/analytics";
import { UnsavedChangesDialogHost } from "src/screens/connection/UnsavedChangesDialogHost";

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
    trackScreenView(activeProfileScreen || "main");
  }, [activeProfileScreen]);

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
    String(licenseState?.status ?? "")
      .trim()
      .toLowerCase() === "active";
  const isTrialExpired = useMemo(() => {
    const expiresAt = Number(licenseState?.trial_expires_at ?? 0);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
  }, [licenseState?.trial_expires_at, now]);
  const isAppLocked = licenseLoaded && !isLicenseActive && isTrialExpired;

  return (
    <div class="app-header flex h-screen flex-col overflow-hidden rounded-t-xl bg-neutral-50 select-none">
      <AppHeader
        activeTabId={activeProfileScreen}
        activeNav={activeProfileScreen || "main"}
        onNavChange={setActiveProfileScreen}
      />
      <div class="flex-1 overflow-hidden bg-white">
        {activeProfileScreen === "main" && <MainScreen />}
        {activeTab && <ConnectionScreen />}
      </div>
      <UnsavedChangesDialogHost />

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
