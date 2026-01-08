import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Plus, X, Database, Bell } from "./icons";
import { ReactNode } from "preact/compat";
import { Tab } from "../stores/screen";
import { useScreenStore } from "../stores/screen";
import { WindowControls } from "./WindowControls";
import { Button } from "./common/Button";
import { connectionRemove } from "src/lib/tauri";
import { tableKey, useLoadTableData } from "../hooks/useLoadTableData";
import { useConnectionStore } from "../stores/connection";

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
  const { tabs, removeTab, activeScreen, setActiveScreen, tabOpenTables } =
    useScreenStore();
  const { tableDataMap } = useConnectionStore();
  const { removeTableData } = useLoadTableData();

  let clickTimer: number | null = null;

  async function handleHeaderClick(e: MouseEvent) {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest('[data-tauri-drag-region="false"]')) return;

    win.startDragging();

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
    removeTab(tabId);

    if (activeScreen === tabId) {
      // If closing active tab, switch to another tab or clear
      if (newTabs.length > 0) {
        setActiveScreen(newTabs[newTabs.length - 1].id);
      } else {
        setActiveScreen("main");
      }
    }

    if (currentTab?.runtimeConnectionId) {
      // Clean up runtime connection
      connectionRemove(currentTab?.runtimeConnectionId);
    }
    if (tabOpenTables[tabId]?.length > 0) {
      Promise.all(
        tabOpenTables[tabId].map((t) => {
          const { schema, name } = t.table;
          const key = tableKey(activeScreen, schema, name);
          const { connectionId } = tableDataMap[key] || { connectionId: null };
          removeTableData(schema, name);

          if (connectionId) {
            connectionRemove(connectionId);
          }
        })
      );
    }
  }

  return (
    <div
      class="z-10 flex h-10 w-full shrink-0 items-center gap-2 rounded-t-xl border-b border-neutral-800 bg-neutral-900/95 px-2 backdrop-blur-md select-none"
      onMouseDown={handleHeaderClick}
    >
      {/* Left side - macOS window controls */}
      {showWindowControls && <WindowControls />}

      {/* Navigation Buttons */}
      <div class="flex shrink-0 items-center gap-1">
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
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            class={`group flex w-full max-w-44 cursor-pointer items-center justify-between gap-1.5 rounded-md py-1.25 pr-2 pl-4 transition-colors ${
              activeScreen === tab.id
                ? "bg-neutral-700 text-white hover:bg-neutral-700"
                : "bg-neutral-800/50 text-neutral-300 hover:bg-neutral-700 hover:text-white"
            }`}
            onClick={() => handleTabSelect?.(tab.id)}
          >
            <span class="max-w-37.5 truncate text-xs font-medium">
              {tab.label}
            </span>
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleTabClose?.(tab.id);
              }}
              active={activeScreen === tab.id}
              class={`rounded-full p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/20 ${
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
      <div class="flex shrink-0 items-center gap-2">
        {onNewTab && (
          <button
            type="button"
            onClick={onNewTab}
            class="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md bg-neutral-800 text-neutral-300 transition-colors hover:bg-neutral-700"
            title="New Tab"
          >
            <Plus className="size-4" />
          </button>
        )}
        <Button
          className="bg-transparent p-2 text-neutral-300 hover:bg-transparent hover:text-neutral-400"
          variant="ghost"
          title="Notifications"
        >
          <Bell className="size-4" />
        </Button>
      </div>
    </div>
  );
}
