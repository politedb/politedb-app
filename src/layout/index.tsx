import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { ConnectionScreen } from "src/screens/connection/ConnectionScreen";
import { useEffect } from "preact/hooks";

export function MainLayout() {
  const { activeProfileScreen, setActiveProfileScreen, profileTabs } =
    useScreenStore();

  const isTab = !!activeProfileScreen && activeProfileScreen.startsWith("tab-");
  const activeTab = isTab
    ? profileTabs.find((t) => t.id === activeProfileScreen)
    : null;

  useEffect(() => {
    if (isTab && !activeTab) setActiveProfileScreen("main");
  }, [isTab, activeTab, setActiveProfileScreen]);

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
    </div>
  );
}
