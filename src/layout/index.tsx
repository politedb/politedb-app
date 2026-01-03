import { MainScreen } from "../screens/MainScreen";
import { useScreenStore } from "../stores/screen";
import { AppHeader } from "../components/AppHeader";
import { ConnectionScreen } from "../screens/ConnectionScreen";

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
