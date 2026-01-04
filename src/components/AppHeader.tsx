import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Plus, X, Database, Bell } from "./icons";
import { ReactNode } from "preact/compat";
import { Tab } from "../stores/screen";
import { useScreenStore } from "../stores/screen";
import { WindowControls } from "./WindowControls";
import { Button } from "./common/Button";

const win = getCurrentWebviewWindow();

type AppHeaderProps = {
  showWindowControls?: boolean;
  onNewTab?: () => void;
  tabs?: Tab[];
  activeTabId?: string | null;
  onTabSelect?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  activeNav?: string | null;
  onNavChange?: (navId: string) => void;
};

type NavButton = {
  id: string;
  label: string;
  icon: ReactNode;
};

const NAV_BUTTONS: NavButton[] = [
  { id: "main", label: "Databases", icon: <Database className="size-3.5" /> },
];

export function AppHeader({
  showWindowControls = true,
  onNewTab,
  activeNav = "main",
  onNavChange,
}: AppHeaderProps) {
  const { tabs, setTabs, activeScreen, setActiveScreen } = useScreenStore();

  let clickTimer: number | null = null;

  async function handleHeaderClick() {
    if (clickTimer) {
      // double click detected
      clearTimeout(clickTimer);
      clickTimer = null;

      const isMax = await win.isMaximized();
      if (isMax) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
      return;
    }

    clickTimer = window.setTimeout(() => {
      clickTimer = null;
    }, 250); // macOS double-click threshold
  }

  function handleTabSelect(tabId: string) {
    setActiveScreen(tabId);
  }

  function handleTabClose(tabId: string) {
    const currentTab = tabs.find((tab) => tab.id === tabId);
    const newTabs = tabs.filter((tab) => tab.id !== tabId);
    setTabs(newTabs);

    if (activeScreen === tabId) {
      // If closing active tab, switch to another tab or clear
      if (newTabs.length > 0) {
        setActiveScreen(newTabs[newTabs.length - 1].id);
      } else {
        setActiveScreen("main");
      }
    }

    const storeKey = currentTab?.id.split("#").pop() || "";
    const localData = JSON.parse(localStorage.getItem(storeKey) || "{}");
    if (localData?.connectionId) {
      // connectionRemove(localData.connectionId);
    }
  }

  return (
    <div
      class="titlebar h-10 bg-neutral-900/95 backdrop-blur-md flex items-center gap-2 px-2 shrink-0 select-none border-b border-neutral-800 w-full z-10 rounded-t-xl"
      onMouseDown={handleHeaderClick}
    >
      {/* Left side - macOS window controls */}
      {showWindowControls && <WindowControls />}

      {/* Navigation Buttons */}
      <div class="flex items-center gap-1 shrink-0">
        {NAV_BUTTONS.map((nav) => (
          <Button
            variant="primary"
            key={nav.id}
            onClick={() => {
              onNavChange?.(nav.id);
              setActiveScreen(nav.id);
            }}
            active={activeNav === nav.id}
            className="py-1.5"
          >
            {nav.icon}
            <span>{nav.label}</span>
          </Button>
        ))}
      </div>

      {/* Tabs */}
      <div class="flex-1 flex items-center gap-1 overflow-x-auto min-w-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            class={`group max-w-44 w-full flex items-center justify-between gap-1.5 pl-4 pr-2 py-1.25 rounded-md transition-colors cursor-pointer ${
              activeScreen === tab.id
                ? "bg-neutral-700 hover:bg-neutral-700 text-white"
                : "bg-neutral-800/50 text-neutral-300 hover:bg-neutral-700 hover:text-white"
            }`}
            onClick={() => handleTabSelect?.(tab.id)}
          >
            <span class="text-xs font-medium truncate max-w-[150px]">{tab.label}</span>
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleTabClose?.(tab.id);
              }}
              active={activeScreen === tab.id}
              class={`opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded-full hover:bg-white/20 text-white ${
                activeScreen === tab.id ? "opacity-100" : ""
              }`}
              title="Close tab"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      {/* Right side - New Tab button and Notifications */}
      <div class="flex items-center gap-2 shrink-0">
        {onNewTab && (
          <button
            type="button"
            onClick={onNewTab}
            class="w-6 h-6 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors cursor-pointer flex items-center justify-center"
            title="New Tab"
          >
            <Plus className="size-4" />
          </button>
        )}
        <Button
          className="text-neutral-300 bg-transparent p-2 hover:bg-transparent hover:text-neutral-400"
          variant="ghost"
          title="Notifications"
        >
          <Bell className="size-4" />
        </Button>
      </div>
    </div>
  );
}
