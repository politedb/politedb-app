import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { ConnectionScreen } from "src/screens/connection/ConnectionScreen";
import { useEffect, useState } from "preact/hooks";
import { useLicenseStore } from "src/stores/license";
import { LicenseDialog } from "src/components/modal/LicenseDialog";
import { trackScreenView } from "src/lib/analytics";
import { UnsavedChangesDialogHost } from "src/screens/connection/UnsavedChangesDialogHost";
import { FloatingAssistantLauncher } from "src/components/ai-assistant/FloatingAssistantLauncher";

export function MainLayout() {
  const { activeProfileScreen, setActiveProfileScreen, profileTabs } =
    useScreenStore();
  const loadLicense = useLicenseStore((s) => s.load);
  const licenseState = useLicenseStore((s) => s.state);
  const licenseLoaded = useLicenseStore((s) => s.loaded);
  const [licenseOpen, setLicenseOpen] = useState(false);

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

  const isAiLocked =
    licenseLoaded && (licenseState?.status ?? "").toLowerCase() !== "active";

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
      <FloatingAssistantLauncher
        aiLocked={isAiLocked}
        onOpenLicense={() => setLicenseOpen(true)}
      />
      <UnsavedChangesDialogHost />
      <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
    </div>
  );
}
