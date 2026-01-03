import { useState } from "preact/compat";
import { MainScreen } from "../screens/MainScreen";
import { Tab, useScreenStore } from "../stores/screen";
import { AppHeader } from "../components/AppHeader";
import { ConnectionScreen } from "../screens/ConnectionScreen";

export function MainLayout() {
  const { activeScreen, setActiveScreen } = useScreenStore();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  function openConnectionInTab(connectionId: string, connectionData: any) {
    // Check if tab already exists
    const existingTab = tabs.find((tab) => tab.connectionId === connectionId);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    // Create new tab
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random()}`,
      label: connectionData.name || "Unnamed Connection",
      connectionId,
      connectionData,
    };

    setTabs([...tabs, newTab]);
    setActiveTabId(newTab.id);
    // setShowConnectionModal(false);
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <div>
      <AppHeader
        // onNewTab={handleNewConnection}
        tabs={tabs}
        activeTabId={activeTabId}
        activeNav={activeScreen || "main"}
        onNavChange={setActiveScreen}
      />
      {activeScreen === "main" && <MainScreen />}
      {activeScreen?.startsWith("tab-") && <ConnectionScreen />}
    </div>
  );
}
