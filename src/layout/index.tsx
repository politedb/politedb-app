import { MainScreen } from "src/screens/main/MainScreen";
import { useScreenStore } from "src/stores/screen";
import { AppHeader } from "src/components/AppHeader";
import { ConnectionScreen } from "src/screens/ConnectionScreen";

export function MainLayout() {
  const { activeScreen, setActiveScreen } = useScreenStore();

  return (
    <div class="h-screen flex flex-col bg-neutral-50 overflow-hidden rounded-t-xl">
      <AppHeader
        activeTabId={activeScreen}
        activeNav={activeScreen || "main"}
        onNavChange={setActiveScreen}
      />
      <div class="flex-1 overflow-hidden bg-white">
        {activeScreen === "main" && <MainScreen />}
        {activeScreen?.startsWith("tab-") && <ConnectionScreen />}
      </div>
    </div>
  );
}
