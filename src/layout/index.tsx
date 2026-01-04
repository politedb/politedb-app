import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { ConnectionScreen } from "src/screens/ConnectionScreen";
import { useEffect } from "preact/hooks";

export function MainLayout() {
  const { activeScreen, setActiveScreen, tabs } = useScreenStore();

  const isTab = !!activeScreen && activeScreen.startsWith("tab-");
  const activeTab = isTab ? tabs.find((t) => t.id === activeScreen) : null;

  useEffect(() => {
    if (isTab && !activeTab) setActiveScreen("main");
  }, [isTab, activeTab, setActiveScreen]);

  return (
    <div class="h-screen flex flex-col bg-neutral-50 overflow-hidden rounded-t-xl">
      <AppHeader
        activeTabId={activeScreen}
        activeNav={activeScreen || "main"}
        onNavChange={setActiveScreen}
      />
      <div class="flex-1 overflow-hidden bg-white">
        {activeScreen === "main" && <MainScreen />}
        {activeTab && <ConnectionScreen />}
      </div>
    </div>
  );
}
