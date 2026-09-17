import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { AppStatusBar } from "src/components/AppStatusBar";
import { useEffect } from "preact/hooks";
import { useLicenseStore } from "src/stores/license";
import { trackScreenView } from "src/lib/analytics";
import { UnsavedChangesDialogHost } from "src/screens/connection/UnsavedChangesDialogHost";
import { FloatingAssistantLauncher } from "src/components/ai-assistant/FloatingAssistantLauncher";
import { Spinner } from "src/components/common/Spinner";
import { Toast } from "@root/src/components/common/Toast";
import { createRetryableLazy } from "src/components/common/RetryableLazy";

const loadConnectionScreen = () =>
  import("src/screens/connection/ConnectionScreen").then((module) => ({
    default: module.ConnectionScreen,
  }));

const ConnectionScreen = createRetryableLazy(loadConnectionScreen, {
  label: "connection",
  renderFallback: () => (
    <div class="flex h-full items-center justify-center">
      <Spinner className="text-blue-600" />
    </div>
  ),
});

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
        {activeTab && <ConnectionScreen />}
      </div>
      <AppStatusBar />
      <FloatingAssistantLauncher />
      <UnsavedChangesDialogHost />
      <Toast />
    </div>
  );
}
