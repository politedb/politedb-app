import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { XIcon, DatabaseIcon } from "./icons";
import { ReactNode } from "preact/compat";
import { useMemo, useRef, useCallback, useState } from "preact/hooks";

import { ProfileTab, useScreenStore } from "../stores/screen";
import { Button } from "./common/Button";
import { requestCloseConnectionTab } from "src/screens/connection/connectionTabClose";
import { DbIcon } from "./icons/DbIcon";
import { ContextMenu, type MenuItem } from "./common/ContextMenu";
import { cn } from "../utils/cn";
import {
  formatShortcutLabel,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";

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
  {
    id: "main",
    label: "Databases",
    icon: <DatabaseIcon className="size-4.5" />,
  },
];

export function AppHeader({ activeNav = "main", onNavChange }: AppHeaderProps) {
  const closeShortcut = useKeyboardShortcutsStore(
    (s) => s.shortcuts.closeCurrent
  );
  const { profileTabs, activeProfileScreen, setActiveProfileScreen } =
    useScreenStore();
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
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    tabId: string;
    tabIndex: number;
  } | null>(null);

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

  const handleTabClose = useCallback((tabId: string) => {
    void requestCloseConnectionTab(tabId);
  }, []);

  const closeTabs = useCallback(
    async (tabIds: string[]) => {
      for (const id of tabIds) {
        await handleTabClose(id);
      }
    },
    [handleTabClose]
  );

  const menuItems: MenuItem[] = ctx
    ? [
        {
          type: "item",
          label: "Close",
          shortcut: formatShortcutLabel(closeShortcut),
          onClick: () => void handleTabClose(ctx.tabId),
        },
        {
          type: "item",
          label: "Close Others",
          disabled: profileTabs.length <= 1,
          onClick: () =>
            void closeTabs(
              profileTabs
                .filter((tab) => tab.id !== ctx.tabId)
                .map((tab) => tab.id)
            ),
        },
        {
          type: "item",
          label: "Close to the Right",
          disabled: ctx.tabIndex >= profileTabs.length - 1,
          onClick: () =>
            void closeTabs(
              profileTabs.slice(ctx.tabIndex + 1).map((tab) => tab.id)
            ),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Close All",
          shortcut: "⌘⇧W",
          disabled: profileTabs.length === 0,
          onClick: () => void closeTabs(profileTabs.map((tab) => tab.id)),
        },
      ]
    : [];

  return (
    <div
      class="relative z-20 h-11 w-full shrink-0 border-b border-slate-200 select-none"
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
                class={cn(
                  "inline-flex items-center gap-1.5",
                  "rounded-lg px-2.5 py-1.25 shadow-sm",
                  "border text-sm font-medium transition-colors",
                  isActive
                    ? "border-blue-300 bg-blue-100 text-blue-600"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50 hover:text-slate-800"
                )}
                aria-current={isActive ? "page" : undefined}
                data-tauri-drag-region="false"
              >
                <span class={isActive ? "text-blue-600" : "text-neutral-600"}>
                  {nav.icon}
                </span>
                <span class="leading-none">{nav.label}</span>
              </button>
            );
          })}
        </div>

        <div class="flex min-w-0 flex-1 items-center">
          <div class="no-scrollbar flex items-center gap-1 overflow-x-auto rounded-lg py-1 pr-2 pl-0">
            {profileTabs.map((tab, tabIndex) => {
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtx({
                      x: e.clientX,
                      y: e.clientY,
                      tabId: tab.id,
                      tabIndex,
                    });
                  }}
                  data-tauri-drag-region="false"
                  class={cn(
                    "group w-48 shadow-sm",
                    "flex items-center justify-between gap-2",
                    "rounded-md border px-2 py-1 transition-all",
                    isActive
                      ? "border-slate-300 bg-white text-slate-900"
                      : "border-transparent bg-slate-100 text-slate-600 hover:border-slate-200/20 hover:bg-slate-50"
                  )}
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="flex size-5 items-center justify-center text-slate-600">
                      <DbIcon engine={tab.engine} px={16} />
                    </span>

                    <span class="truncate text-sm font-medium">
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
                    class={cn(
                      "rounded-full border-none p-0 text-slate-400 transition hover:bg-transparent hover:text-slate-700",
                      !isActive &&
                        "opacity-60 group-hover:opacity-100 hover:bg-transparent"
                    )}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <ContextMenu
        open={!!ctx}
        x={ctx?.x ?? 0}
        y={ctx?.y ?? 0}
        items={menuItems}
        onClose={() => setCtx(null)}
      />
    </div>
  );
}
