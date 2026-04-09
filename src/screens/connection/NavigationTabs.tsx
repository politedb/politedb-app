import { useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Table, X, ChevronLeft, ChevronRight } from "src/components/icons";
import type { OpenWindow } from "src/types";
import { cn } from "src/utils/cn";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";

interface Props {
  openWindows: OpenWindow[];
  setActiveWindowId: (id: string) => void;
  activeWindowId: string | null;
}

function getWindowTitle(w: OpenWindow) {
  if (w.type === "table") return w.table.name;
  return w.title?.trim() ? w.title : "SQL Query";
}

function getWindowSubtitle(w: OpenWindow) {
  if (w.type === "table") return `${w.table.schema}.${w.table.name}`;
  return "SQL Editor";
}

export function NavigationTabs({
  openWindows,
  setActiveWindowId,
  activeWindowId,
}: Props) {
  const actions = useConnectionActionsCtx();
  const scrollerRef = useRef<HTMLDivElement>(null);

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
          shortcut: "⌘W",
          onClick: () => closeNow(ctx.tabId),
        },
        {
          type: "item",
          label: "Close Others",
          disabled: openWindows.length <= 1,
          onClick: () =>
            openWindows.forEach((w) => w.id !== ctx.tabId && closeNow(w.id)),
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
    <div
      class={cn(
        "flex shrink-0 items-end overflow-x-auto overflow-y-hidden pt-1"
      )}
    >
      <div class="flex w-full items-stretch bg-neutral-100">
        {/* Left */}
        <div class="flex shrink-0 items-center px-1">
          <Button
            variant="ghost"
            className="group size-7 rounded-md p-0 hover:bg-transparent"
            onClick={() => scrollBy(-1)}
            title="Scroll left"
          >
            <ChevronLeft className="size-4 text-neutral-500 transition-colors group-hover:text-neutral-900" />
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
                onClick={() => setActiveWindowId(w.id)}
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
                  <Table className="size-4 text-neutral-500" />
                )}

                {w.type === "sql" && (
                  <span class="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">
                    SQL
                  </span>
                )}

                <span
                  class={cn(
                    "max-w-40 truncate select-none",
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
                  <X className="size-3.5 text-neutral-500 hover:text-neutral-700" />
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
            <ChevronRight className="size-4 text-neutral-500 transition-colors group-hover:text-neutral-900" />
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
