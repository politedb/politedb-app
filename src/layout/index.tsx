import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { AppStatusBar } from "src/components/status-bar/AppStatusBar";
import { useEffect } from "preact/hooks";
import { useLicenseStore } from "src/stores/license";
import { trackScreenView } from "src/lib/analytics";
import { UnsavedChangesDialogHost } from "src/screens/connection/workspace/UnsavedChangesDialogHost";
import { FloatingAssistantLauncher } from "src/components/ai-assistant/FloatingAssistantLauncher";
import { WelcomeDialogHost } from "src/components/modal/WelcomeDialogHost";
import { ProUpgradeDialogHost } from "src/components/license/ProUpgradeDialogHost";
import { ExplainAnalyzeConfirmHost } from "src/components/editor/query-analyzer/ExplainAnalyzeConfirmHost";
import { DumpProgressDialog } from "src/components/modal/DumpProgressDialog";
import { useConnectionQuitGuard } from "src/screens/connection/hooks/useConnectionQuitGuard";
import { Spinner } from "src/components/common/Spinner";
import { Toast } from "@root/src/components/common/Toast";
import { createRetryableLazy } from "src/components/common/RetryableLazy";
import {
  isModalDialogOpen,
  isOpenSettingsShortcut,
  requestOpenSettings,
} from "src/lib/settings/openSettings";
import { isMacPlatform } from "src/stores/keyboardShortcuts";
import { handleConnectionTabShortcut } from "src/lib/tabs/handleConnectionTabShortcut";

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
  // For the window's whole life: no screen change can drop it (D8).
  useConnectionQuitGuard();

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

  // ⌘, (Ctrl+, elsewhere) opens Settings from any screen; Settings lives on the
  // main screen, so switch there first. ⌘1…9 and Ctrl+Tab switch connection
  // tabs.
  useEffect(() => {
    const isMac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (handleConnectionTabShortcut(event, isMac)) return;
      if (!isOpenSettingsShortcut(event, isMac)) return;
      event.preventDefault();
      // Another dialog is open (New Group, a form…): leave it alone rather than
      // stacking Settings on top or under it.
      if (isModalDialogOpen()) return;
      setActiveProfileScreen("main");
      requestOpenSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setActiveProfileScreen]);

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
      <WelcomeDialogHost />
      <UnsavedChangesDialogHost />
      <ProUpgradeDialogHost />
      <ExplainAnalyzeConfirmHost />
      <DumpProgressDialog />
      <Toast />
    </div>
  );
}
