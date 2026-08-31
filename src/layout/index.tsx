import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { useEffect } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import { useLicenseStore } from "src/stores/license";
import { trackScreenView } from "src/lib/analytics";
import { UnsavedChangesDialogHost } from "src/screens/connection/UnsavedChangesDialogHost";
import { FloatingAssistantLauncher } from "src/components/ai-assistant/FloatingAssistantLauncher";

const ConnectionScreen = lazy(() =>
  import("src/screens/connection/ConnectionScreen").then((module) => ({
    default: module.ConnectionScreen,
  }))
);

export function MainLayout() {
  const { activeProfileScreen, setActiveProfileScreen, profileTabs } =
    useScreenStore();
  const loadLicense = useLicenseStore((state) => state.load);

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

  return (
    <div class="app-header flex h-screen flex-col overflow-hidden rounded-t-xl bg-neutral-50 select-none">
      <AppHeader
        activeTabId={activeProfileScreen}
        activeNav={activeProfileScreen || "main"}
        onNavChange={setActiveProfileScreen}
      />
      <div class="flex-1 overflow-hidden bg-white">
        {activeProfileScreen === "main" && <MainScreen />}
        {activeTab && (
          <Suspense fallback={null}>
            <ConnectionScreen />
          </Suspense>
        )}
      </div>
      <FloatingAssistantLauncher />
      <UnsavedChangesDialogHost />
    </div>
  );
}
