import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X, Database } from "./icons";
import { ReactNode } from "preact/compat";
import { useMemo, useRef, useCallback } from "preact/hooks";

import { ProfileTab, useScreenStore } from "../stores/screen";
import { Button } from "./common/Button";
import { connectionRemove } from "src/lib/tauri";
import { tableKey, useLoadTableData } from "../hooks/useLoadTableData";
import { useConnectionStore } from "../stores/connection";
import { DbIcon } from "./icons/DbIcon";

function isTauriRuntime() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

type AppHeaderProps = {
  showWindowControls?: boolean;
  onNewTab?: () => void;
  profileTabs?: ProfileTab[];
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

export function AppHeader({ activeNav = "main", onNavChange }: AppHeaderProps) {
  const {
    profileTabs,
    removeTab,
    activeProfileScreen,
    setActiveProfileScreen,
    openWindows,
  } = useScreenStore();
  const { tableDataMap } = useConnectionStore();
  const { removeTableData } = useLoadTableData();

  // ✅ create window handle only in Tauri runtime
  const win = useMemo(() => {
    if (!isTauriRuntime()) return null;
    try {
      return getCurrentWebviewWindow();
    } catch {
      return null;
    }
  }, []);

  const lastClickAtRef = useRef<number>(0);
  const DOUBLE_CLICK_MS = 280;

  const handleHeaderMouseDown = useCallback(
    async (e: MouseEvent) => {
      if (!win) return; // ✅ in browser => no-op
      if (e.button !== 0) return;

      const el = e.target as HTMLElement;
      if (el.closest('[data-tauri-drag-region="false"]')) return;

      const now = Date.now();
      const isDouble = now - lastClickAtRef.current < DOUBLE_CLICK_MS;
      lastClickAtRef.current = now;

      if (isDouble) {
        try {
          const isMax = await win.isMaximized();
          if (isMax) await win.unmaximize();
          else await win.maximize();
        } catch {
          // ignore
        }
        return;
      }

      try {
        await win.startDragging();
      } catch {
        // ignore
      }
    },
    [win]
  );

  const handleTabSelect = useCallback(
    (tabId: string) => {
      setActiveProfileScreen(tabId);
    },
    [setActiveProfileScreen]
  );

  const handleTabClose = useCallback(
    async (tabId: string) => {
      const currentTab = profileTabs.find((tab) => tab.id === tabId);
      const newTabs = profileTabs.filter((tab) => tab.id !== tabId);

      removeTab(tabId);

      if (activeProfileScreen === tabId) {
        setActiveProfileScreen(
          newTabs.length > 0 ? newTabs[newTabs.length - 1].id : "main"
        );
      }

      if (currentTab?.runtimeConnectionId) {
        try {
          await connectionRemove(currentTab.runtimeConnectionId);
        } catch (err) {
          console.error("Error removing runtime connection:", err);
        }
      }

      const windows = openWindows[tabId] ?? [];
      if (windows.length === 0) return;

      const tableWindows = windows.filter((w) => w.type === "table");

      await Promise.all(
        tableWindows.map(async (w) => {
          const { schema, name } = w.table;

          const key = tableKey(tabId, schema, name);
          const { connectionId } = tableDataMap[key] || { connectionId: null };

          // ⚠️
          // Recommend removeTableData signature: removeTableData(screenId, schema, name)
          removeTableData(schema, name);

          if (connectionId) {
            try {
              await connectionRemove(connectionId);
            } catch (err) {
              console.error("Error removing table connection:", err);
            }
          }
        })
      );
    },
    [
      profileTabs,
      removeTab,
      activeProfileScreen,
      setActiveProfileScreen,
      openWindows,
      tableDataMap,
      removeTableData,
    ]
  );

  return (
    <div
      class="relative z-10 h-10 w-full shrink-0 border-b border-slate-200 backdrop-blur-md select-none"
      onMouseDown={handleHeaderMouseDown}
    >
      <div
        class="absolute top-0 left-0 flex h-full items-center"
        style={{ width: "var(--titlebar-left-padding)" }}
      />

      <div
        class="flex h-full items-center"
        style={{ paddingLeft: "var(--titlebar-left-padding)" }}
      >
        <div
          class="flex h-full shrink-0 items-center gap-2 px-4"
          style={{
            width: "calc(var(--sidebar-width) - var(--titlebar-left-padding))",
          }}
          data-tauri-drag-region="false"
        >
          {NAV_BUTTONS.map((nav) => {
            const isActive = activeNav === nav.id;

            return (
              <button
                key={nav.id}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onNavChange?.(nav.id);
                  setActiveProfileScreen(nav.id);
                }}
                class={[
                  "inline-flex cursor-pointer items-center gap-1.5",
                  "h-7 rounded-lg px-2.5",
                  "border text-xs font-semibold transition-colors",
                  isActive
                    ? "border-blue-300 bg-blue-100 text-blue-500"
                    : "border-slate-200 bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                ].join(" ")}
                aria-current={isActive ? "page" : undefined}
                data-tauri-drag-region="false"
              >
                <span class={isActive ? "text-blue-500" : "text-slate-400"}>
                  {nav.icon}
                </span>
                <span class="leading-none">Databases</span>
              </button>
            );
          })}
        </div>

        <div class="flex min-w-0 flex-1 items-center">
          <div class="flex items-center gap-1 overflow-x-auto rounded-lg p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {profileTabs.map((tab) => {
              const isActive = activeProfileScreen === tab.id;

              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTabSelect(tab.id);
                  }}
                  data-tauri-drag-region="false"
                  class={[
                    "group w-44 shrink-0 cursor-pointer",
                    "flex items-center justify-between gap-2",
                    "rounded-md border px-3 py-1 transition-all",
                    isActive
                      ? "border-slate-300 bg-white text-slate-900 shadow-[0_1px_0_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.06)]"
                      : "border-transparent bg-slate-100 text-slate-600 hover:border-slate-200 hover:bg-slate-50",
                  ].join(" ")}
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-slate-600">
                      <DbIcon engine={tab.engine} px={16} />
                    </span>
                    <span class="truncate text-xs font-medium">
                      {tab.label}
                    </span>
                  </div>

                  <Button
                    variant="ghost"
                    title="Close tab"
                    data-tauri-drag-region="false"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTabClose(tab.id);
                    }}
                    class={[
                      "rounded-full p-0.5 transition",
                      isActive
                        ? "text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                        : "text-slate-400 opacity-60 group-hover:opacity-100 hover:bg-slate-200 hover:text-slate-700",
                    ].join(" ")}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
