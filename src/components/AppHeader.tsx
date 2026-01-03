import { getCurrentWindow } from "@tauri-apps/api/window";
import { Plus, X, Database } from "./icons";
import { ReactNode } from "preact/compat";
import { Tab } from "../stores/screen";
import { useScreenStore } from "../stores/screen";

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
  { id: "main", label: "Databases", icon: <Database className="size-3" /> },
];

export function AppHeader({
  showWindowControls = true,
  onNewTab,
  activeNav = "main",
  onNavChange,
}: AppHeaderProps) {
  const { tabs, setTabs, activeScreen, setActiveScreen } = useScreenStore();

  function handleTabSelect(tabId: string) {
    setActiveScreen(tabId);
  }

  function handleTabClose(tabId: string) {
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
  }

  async function handleClose() {
    const appWindow = getCurrentWindow();
    await appWindow.close();
  }

  async function handleMinimize() {
    const appWindow = getCurrentWindow();
    await appWindow.minimize();
  }

  async function handleMaximize() {
    const appWindow = getCurrentWindow();
    const isMaximized = await appWindow.isMaximized();
    if (isMaximized) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  }

  return (
    <div
      data-tauri-drag-region
      class="h-10 bg-neutral-900/95 backdrop-blur-md flex items-center gap-2 px-2 shrink-0 select-none border-b border-neutral-800"
    >
      {/* Left side - macOS window controls */}
      {showWindowControls && (
        <div class="flex items-center gap-2 shrink-0" data-tauri-drag-region>
          <button
            type="button"
            class="w-3 h-3 rounded-full bg-[#ff5f57] hover:bg-[#ff3b30] transition-colors cursor-pointer flex items-center justify-center group"
            title="Close"
            onClick={handleClose}
          >
            <span class="w-1 h-1 rounded-full bg-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"></span>
          </button>
          <button
            type="button"
            class="w-3 h-3 rounded-full bg-[#ffbd2e] hover:bg-[#ff9500] transition-colors cursor-pointer flex items-center justify-center group"
            title="Minimize"
            onClick={handleMinimize}
          >
            <span class="w-1 h-1 rounded-full bg-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"></span>
          </button>
          <button
            type="button"
            class="w-3 h-3 rounded-full bg-[#28c840] hover:bg-[#20d046] transition-colors cursor-pointer flex items-center justify-center group"
            title="Maximize"
            onClick={handleMaximize}
          >
            <span class="w-1 h-1 rounded-full bg-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"></span>
          </button>
        </div>
      )}

      {/* Navigation Buttons */}
      <div class="flex items-center gap-1 shrink-0" data-tauri-drag-region>
        {NAV_BUTTONS.map((nav) => (
          <button
            key={nav.id}
            type="button"
            onClick={() => {
              onNavChange?.(nav.id);
              setActiveScreen(nav.id);
            }}
            class={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeNav === nav.id
                ? "bg-neutral-800 hover:bg-neutral-700 text-white"
                : "bg-neutral-800/50 text-neutral-300 hover:bg-neutral-800 hover:text-white"
            }`}
          >
            {nav.icon}
            <span>{nav.label}</span>
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div class="flex-1 flex items-center gap-1 overflow-x-auto min-w-0" data-tauri-drag-region>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            class={`group flex items-center gap-1.5 pl-3 pr-2 py-1 rounded-lg transition-colors cursor-pointer min-w-0 shrink-0 ${
              activeScreen === tab.id
                ? "bg-blue-500 text-white"
                : "bg-neutral-800/50 text-neutral-300 hover:bg-neutral-800 hover:text-white"
            }`}
            onClick={() => handleTabSelect?.(tab.id)}
          >
            <span class="text-xs font-medium truncate max-w-[150px]">{tab.label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleTabClose?.(tab.id);
              }}
              class={`opacity-0 cursor-pointer group-hover:opacity-100 transition-opacity p-0.5 rounded-full hover:bg-white/20 ${
                activeScreen === tab.id ? "opacity-100" : ""
              }`}
              title="Close tab"
            >
              <X className="size-3.5" />
            </button>
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
        <button
          type="button"
          class="w-6 h-6 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors cursor-pointer flex items-center justify-center"
          title="Notifications"
        >
          <svg class="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
