import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  TableIcon,
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SquareFunctionIcon,
} from "src/components/icons";
import type { OpenWindow } from "src/types";
import { cn } from "src/utils/cn";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import {
  formatShortcutLabel,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";

interface Props {
  openWindows: OpenWindow[];
  setActiveWindowId: (id: string) => void;
  activeWindowId: string | null;
}

export function getTabRevealScrollLeft(args: {
  scrollLeft: number;
  viewportLeft: number;
  viewportRight: number;
  tabLeft: number;
  tabRight: number;
  padding?: number;
}) {
  const {
    scrollLeft,
    viewportLeft,
    viewportRight,
    tabLeft,
    tabRight,
    padding = 4,
  } = args;

  if (tabLeft < viewportLeft + padding) {
    return Math.max(0, scrollLeft + tabLeft - viewportLeft - padding);
  }
  if (tabRight > viewportRight - padding) {
    return scrollLeft + tabRight - viewportRight + padding;
  }
  return null;
}

function getWindowTitle(w: OpenWindow) {
  if (w.type === "table") return w.table.name;
  if (w.type === "db-catalog") return w.title?.trim() || "Catalog";
  if (w.type === "db-object-manager") return w.title?.trim() || "Objects";
  return w.title?.trim() ? w.title : "SQL Query";
}

function getWindowSubtitle(w: OpenWindow) {
  if (w.type === "table") return `${w.table.schema}.${w.table.name}`;
  if (w.type === "db-catalog") return "Database metadata overview";
  if (w.type === "db-object-manager") return "Functions, procedures, triggers";
  return "SQL Editor";
}

export function NavigationTabs({
  openWindows,
  setActiveWindowId,
  activeWindowId,
}: Props) {
  const actions = useConnectionActionsCtx();
  const closeShortcut = useKeyboardShortcutsStore(
    (s) => s.shortcuts.closeCurrent
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());

  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    tabId: string;
    tabIndex: number;
  } | null>(null);

  const scrollBy = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: el.clientWidth * 0.7 * dir, behavior: "smooth" });
  };

  const revealTab = useCallback((id: string, behavior: ScrollBehavior) => {
    const scroller = scrollerRef.current;
    const tab = tabRefs.current.get(id);
    if (!scroller || !tab) return;

    const viewportRect = scroller.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const left = getTabRevealScrollLeft({
      scrollLeft: scroller.scrollLeft,
      viewportLeft: viewportRect.left,
      viewportRight: viewportRect.right,
      tabLeft: tabRect.left,
      tabRight: tabRect.right,
    });
    if (left == null) return;
    scroller.scrollTo({ left, behavior });
  }, []);

  useEffect(() => {
    if (!activeWindowId) return;
    const rafId = requestAnimationFrame(() =>
      revealTab(activeWindowId, "smooth")
    );
    return () => cancelAnimationFrame(rafId);
  }, [activeWindowId, openWindows, revealTab]);

  const onWheel = (e: WheelEvent) => {
    const el = scrollerRef.current;
    if (!el) return;

    // keep native horizontal trackpad scroll
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

    e.preventDefault();
    el.scrollLeft += e.deltaY;
  };

  const closeNow = (id: string) => {
    actions.closeWindow(id, new MouseEvent("click"));
  };

  const menuItems: MenuItem[] = ctx
    ? [
        {
          type: "item",
          label: "Close",
          shortcut: formatShortcutLabel(closeShortcut),
          onClick: () => closeNow(ctx.tabId),
        },
        {
          type: "item",
          label: "Close Others",
          disabled: openWindows.length <= 1,
          onClick: () =>
            openWindows.forEach((w) => w.id !== ctx.tabId && closeNow(w.id)),
        },
        {
          type: "item",
          label: "Close to the Right",
          disabled: ctx.tabIndex >= openWindows.length - 1,
          onClick: () =>
            openWindows.slice(ctx.tabIndex + 1).forEach((w) => closeNow(w.id)),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Close All",
          shortcut: "⌘⇧W",
          onClick: () => openWindows.forEach((w) => closeNow(w.id)),
        },
      ]
    : [];

  return (
    <div class={cn("flex shrink-0 items-end overflow-hidden pt-1")}>
      <div class="flex w-full items-stretch bg-neutral-100">
        {/* Left */}
        <div class="flex shrink-0 items-center px-1">
          <Button
            variant="ghost"
            className="group size-7 rounded-md p-0 hover:bg-transparent"
            onClick={() => scrollBy(-1)}
            title="Scroll left"
          >
            <ChevronLeftIcon className="size-4 text-neutral-500 transition-colors group-hover:text-neutral-900" />
          </Button>
        </div>

        {/* Tabs scroller */}
        <div
          ref={scrollerRef}
          class="flex min-w-0 flex-1 items-end gap-1 overflow-hidden px-1 pt-1"
          onWheel={onWheel}
        >
          {openWindows.map((w, idx) => {
            const active = activeWindowId === w.id;

            return (
              <div
                key={w.id}
                ref={(element) => {
                  if (element) tabRefs.current.set(w.id, element);
                  else tabRefs.current.delete(w.id);
                }}
                onClick={() => {
                  setActiveWindowId(w.id);
                  revealTab(w.id, "smooth");
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({
                    x: e.clientX,
                    y: e.clientY,
                    tabId: w.id,
                    tabIndex: idx,
                  });
                }}
                title={getWindowSubtitle(w)}
                class={cn(
                  "group flex shrink-0 items-center gap-2 rounded-t-md px-2.5 py-1.5 text-xs transition-colors",
                  active
                    ? "bg-white text-neutral-800 ring-1 ring-black/5"
                    : "bg-neutral-200/70 text-neutral-600 hover:bg-neutral-300/80"
                )}
              >
                {w.type === "table" && (
                  <TableIcon className="size-4 text-neutral-500" />
                )}

                {w.type === "db-catalog" &&
                  (w.catalogKind === "functions" ? (
                    <SquareFunctionIcon className="size-4 text-blue-500" />
                  ) : (
                    <TableIcon className="size-4 text-blue-500" />
                  ))}

                {w.type === "sql" && (
                  <span class="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">
                    SQL
                  </span>
                )}

                {w.type === "db-object-manager" && (
                  <SquareFunctionIcon className="size-5 text-blue-500" />
                )}

                <span
                  class={cn(
                    "max-w-40 truncate text-sm font-medium select-none",
                    w.type === "db-object-manager" && "text-[12px]",
                    active && "font-semibold"
                  )}
                >
                  {getWindowTitle(w)}
                </span>

                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeNow(w.id);
                  }}
                  class="ml-1 rounded-full border-none p-0.5 opacity-0 group-hover:opacity-100 hover:bg-neutral-100"
                  title="Close"
                >
                  <XIcon className="size-3.5 text-neutral-500 hover:text-neutral-700" />
                </Button>
              </div>
            );
          })}
        </div>

        {/* Right */}
        <div class="flex shrink-0 items-center px-1">
          <Button
            variant="ghost"
            className="group size-7 rounded-md p-0 hover:bg-transparent"
            onClick={() => scrollBy(1)}
            title="Scroll right"
          >
            <ChevronRightIcon className="size-4 text-neutral-500 transition-colors group-hover:text-neutral-900" />
          </Button>
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
