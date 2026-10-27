import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { XIcon, DatabaseIcon, PlusIcon } from "./icons";
import { ReactNode } from "preact/compat";
import {
  useMemo,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "preact/hooks";

import { ProfileTab, useScreenStore } from "../stores/screen";
import { Button } from "./common/Button";
import { requestCloseConnectionTab } from "src/screens/connection/lib/connectionTabClose";
import { DbIcon } from "./icons/DbIcon";
import { ContextMenu, type MenuItem } from "./common/ContextMenu";
import { cn } from "../utils/cn";
import { normalizeEngineName } from "../utils/convert";
import {
  formatShortcutLabel,
  isMacPlatform,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";
import { useProfileStore } from "src/stores/profile";
import { usePinnedConnectionsStore } from "src/stores/pinnedConnections";
import { connectionTabShortcutHint } from "src/lib/tabs/connectionTabShortcuts";
import { openProfileTab } from "src/lib/tabs/openProfileTab";
import { normalizeQuerySafetyMode } from "src/lib/queries/querySafety";
import { querySafetyModeInfo } from "src/lib/queries/querySafetyModes";
import { connectionTabHasChanges } from "src/screens/connection/lib/tabDirty";
import { useConnectionStore } from "src/stores/connection";
import { useObjectDraftStore } from "src/stores/objectDrafts";

/** Saved connections listed in the new-tab menu; the rest are on Databases. */
const NEW_TAB_MENU_LIMIT = 10;

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

  // Re-render when the unsaved-work markers can change.
  useConnectionStore((s) => s.dataPatchMap);
  useConnectionStore((s) => s.newTableData);
  useObjectDraftStore((s) => s.drafts);
  const profiles = useProfileStore((s) => s.profiles);
  const pinnedIds = usePinnedConnectionsStore((s) => s.pinnedIds);
  const isMac = useMemo(() => isMacPlatform(), []);
  const [newTabMenu, setNewTabMenu] = useState<{ x: number; y: number } | null>(
    null
  );

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

  // The tab strip scrolls sideways without a scrollbar: keep the active tab
  // in view and fade the edges that hide more tabs.
  const stripRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ left: false, right: false });
  const updateHidden = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setHidden((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right }
    );
  }, []);

  useLayoutEffect(() => {
    const el = stripRef.current;
    const active = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    updateHidden();
  }, [activeProfileScreen, profileTabs.length, updateHidden]);

  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHidden);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateHidden]);

  const handleStripWheel = useCallback((e: WheelEvent) => {
    const el = stripRef.current;
    // A plain mouse wheel only scrolls vertically: move the tabs sideways.
    if (!el || e.deltaX !== 0 || e.deltaY === 0) return;
    el.scrollLeft += e.deltaY;
  }, []);

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

  // Roving focus: one tab stop for the strip, arrows move between tabs and
  // Enter or Space switches (switching loads a whole connection screen).
  const focusTab = (index: number) => {
    const tabs =
      stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!tabs?.length) return;
    const target = tabs[(index + tabs.length) % tabs.length];
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  const openTabMenu = (tabId: string, tabIndex: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setCtx({ x: rect.left, y: rect.bottom, tabId, tabIndex });
  };

  const handleTabKeyDown = (
    e: KeyboardEvent,
    tab: ProfileTab,
    tabIndex: number
  ) => {
    const el = e.currentTarget as HTMLElement;
    switch (e.key) {
      case "ArrowRight":
        focusTab(tabIndex + 1);
        break;
      case "ArrowLeft":
        focusTab(tabIndex - 1);
        break;
      case "Home":
        focusTab(0);
        break;
      case "End":
        focusTab(profileTabs.length - 1);
        break;
      case "Enter":
      case " ":
        handleTabSelect(tab.id);
        break;
      case "Delete":
      case "Backspace":
        handleTabClose(tab.id);
        break;
      case "ContextMenu":
        openTabMenu(tab.id, tabIndex, el);
        break;
      case "F10":
        if (!e.shiftKey) return;
        openTabMenu(tab.id, tabIndex, el);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const newTabItems: MenuItem[] = useMemo(() => {
    const pinned = new Set(pinnedIds);
    const sorted = [...profiles].sort(
      (a, b) =>
        Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
        (a.label || "").localeCompare(b.label || "")
    );
    const listed = sorted.slice(0, NEW_TAB_MENU_LIMIT);
    return [
      ...listed.map(
        (profile): MenuItem => ({
          type: "item",
          label: profile.label || "Unnamed Connection",
          icon: <DbIcon engine={profile.engine} px={14} />,
          onClick: () => void openProfileTab(profile),
        })
      ),
      ...(listed.length ? [{ type: "sep" } as MenuItem] : []),
      {
        type: "item",
        label:
          sorted.length > listed.length
            ? `All connections (${sorted.length})…`
            : "All connections…",
        icon: <DatabaseIcon className="size-3.5" />,
        onClick: () => setActiveProfileScreen("main"),
      },
    ];
  }, [profiles, pinnedIds, setActiveProfileScreen]);

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

        <div class="flex min-w-0 flex-1 items-center gap-1 pr-2">
          <div class="relative flex min-w-0 items-center">
            <div
              ref={stripRef}
              role="tablist"
              aria-label="Connections"
              onScroll={updateHidden}
              onWheel={handleStripWheel}
              class="no-scrollbar flex items-center gap-1 overflow-x-auto rounded-lg px-0.5 py-1"
            >
              {profileTabs.map((tab, tabIndex) => {
                const isActive = activeProfileScreen === tab.id;
                const hint = connectionTabShortcutHint(
                  tabIndex,
                  profileTabs.length,
                  isMac
                );
                const mode = normalizeQuerySafetyMode(
                  tab.querySafetyMode ?? (tab.isLocked ? "lock" : "default")
                );
                const modeInfo =
                  mode === "default" ? null : querySafetyModeInfo(mode);
                const unsaved = connectionTabHasChanges(tab.id);
                // The strip's single tab stop: the active tab, else the first.
                const isTabStop =
                  isActive ||
                  (tabIndex === 0 &&
                    !profileTabs.some((t) => t.id === activeProfileScreen));

                return (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isTabStop ? 0 : -1}
                    title={[
                      tab.label,
                      normalizeEngineName(tab.engine),
                      modeInfo?.label,
                      unsaved ? "Unsaved changes" : null,
                      hint,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTabSelect(tab.id);
                    }}
                    onKeyDown={(e) => handleTabKeyDown(e, tab, tabIndex)}
                    onMouseDown={(e) => {
                      // No autoscroll on a middle press; its release closes.
                      if (e.button === 1) e.preventDefault();
                    }}
                    onMouseUp={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      e.stopPropagation();
                      handleTabClose(tab.id);
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
                      "group relative w-48 shadow-sm",
                      "flex items-center justify-between gap-2",
                      "rounded-md border px-2 py-1 transition-all",
                      "outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                      isActive
                        ? "border-slate-300 bg-slate-100 text-slate-900"
                        : "border-transparent bg-white text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    {modeInfo ? (
                      <span
                        aria-hidden="true"
                        data-safety-mode={mode}
                        class={cn(
                          "absolute inset-y-1 left-0 w-0.75 rounded-full",
                          modeInfo.dotClass
                        )}
                      />
                    ) : null}
                    <div class="flex min-w-0 items-center gap-2">
                      <span class="flex size-5 items-center justify-center text-slate-600">
                        <DbIcon engine={tab.engine} px={16} />
                      </span>

                      <span class="truncate text-sm font-medium">
                        {tab.label}
                      </span>
                      {modeInfo ? (
                        <span class="sr-only">{modeInfo.label}</span>
                      ) : null}
                      {unsaved ? (
                        <span class="sr-only">Unsaved changes</span>
                      ) : null}
                    </div>

                    <Button
                      variant="ghost"
                      title="Close tab"
                      aria-label={`Close ${tab.label}`}
                      // Delete closes the focused tab; one stop per tab strip.
                      tabIndex={-1}
                      data-tauri-drag-region="false"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTabClose(tab.id);
                      }}
                      class={cn(
                        "relative rounded-full border-none p-0 text-slate-400 transition hover:bg-transparent hover:text-slate-700",
                        !isActive &&
                          !unsaved &&
                          "opacity-60 group-hover:opacity-100 hover:bg-transparent"
                      )}
                    >
                      {/* Unsaved: the dot sits where × is; hovering or
                          focusing the tab shows × in its place. */}
                      {unsaved ? (
                        <span
                          aria-hidden="true"
                          data-unsaved-dot
                          class="absolute inset-0 flex items-center justify-center group-hover:opacity-0 group-focus-visible:opacity-0"
                        >
                          <span class="size-2 rounded-full bg-slate-400 dark:bg-slate-300" />
                        </span>
                      ) : null}
                      <XIcon
                        className={cn(
                          "size-3.5",
                          unsaved &&
                            "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                        )}
                      />
                    </Button>
                  </div>
                );
              })}
            </div>
            {hidden.left ? (
              <div
                aria-hidden="true"
                data-testid="tabs-fade-left"
                class="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-white to-transparent dark:from-[#181818]"
              />
            ) : null}
            {hidden.right ? (
              <div
                aria-hidden="true"
                data-testid="tabs-fade-right"
                class="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-white to-transparent dark:from-[#181818]"
              />
            ) : null}
          </div>
          <Button
            variant="ghost"
            title="Open a connection"
            aria-label="Open a connection"
            aria-haspopup="menu"
            aria-expanded={!!newTabMenu}
            data-tauri-drag-region="false"
            class="size-7 shrink-0 justify-center rounded-md p-0 text-slate-500 hover:text-slate-800"
            onClick={(e) => {
              e.stopPropagation();
              if (profiles.length === 0) {
                setActiveProfileScreen("main");
                return;
              }
              const rect = (
                e.currentTarget as HTMLElement
              ).getBoundingClientRect();
              setNewTabMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
      </div>

      <ContextMenu
        open={!!newTabMenu}
        x={newTabMenu?.x ?? 0}
        y={newTabMenu?.y ?? 0}
        items={newTabItems}
        onClose={() => setNewTabMenu(null)}
      />
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
