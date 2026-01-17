import { Button } from "src/components/common/Button";
import { Table, X } from "src/components/icons";
import { OpenWindow } from "src/types";
import { cn } from "src/utils/cn";

interface Props {
  openWindows: OpenWindow[];
  setActiveWindowId: (id: string) => void;
  activeWindowId: string | null;
  handleCloseWindow: (id: string, e: MouseEvent) => void;
}

function getWindowTitle(w: OpenWindow) {
  if (w.type === "table") return w.table.name;
  return w.title?.trim() ? w.title : "SQL Query";
}

function getWindowSubtitle(w: OpenWindow) {
  if (w.type === "table") return `${w.table.schema}.${w.table.name}`;
  return "SQL Editor";
}

function WindowIcon() {
  return <Table className="size-4 text-neutral-500" />;
}

export function NavigationTabs({
  openWindows,
  setActiveWindowId,
  activeWindowId,
  handleCloseWindow,
}: Props) {
  return (
    <div
      class={cn(
        "flex items-end gap-1 pt-1",
        "bg-neutral-100",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      )}
    >
      {openWindows.map((w) => {
        const isActive = activeWindowId === w.id;

        return (
          <div
            key={w.id}
            onClick={() => setActiveWindowId(w.id)}
            title={getWindowSubtitle(w)}
            class={cn(
              "group relative z-0 flex shrink-0 cursor-pointer items-center gap-2",
              "rounded-t-md px-2.5 py-1.5 text-xs transition-all",
              isActive
                ? ["z-10", "bg-white text-neutral-800", "ring-1 ring-black/5"]
                : [
                    "bg-neutral-200/70 text-neutral-600",
                    "hover:bg-neutral-300/80",
                  ]
            )}
          >
            {/* Left: icon / badge */}
            <div class="flex items-center gap-2">
              {w.type === "table" && <WindowIcon />}

              {w.type === "sql" && (
                <span
                  class={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
                    isActive
                      ? "bg-indigo-50 text-indigo-600"
                      : "bg-indigo-100/70 text-indigo-600"
                  )}
                >
                  SQL
                </span>
              )}

              <span
                class={cn(
                  "max-w-40 truncate",
                  isActive
                    ? "font-semibold text-neutral-800"
                    : "font-medium text-neutral-600"
                )}
              >
                {getWindowTitle(w)}
              </span>
            </div>

            {/* Close button */}
            <Button
              variant="ghost"
              onClick={(e) => handleCloseWindow(w.id, e)}
              class={cn(
                "ml-1 p-0.5",
                "opacity-0 transition-opacity",
                "group-hover:opacity-100",
                isActive && "opacity-100",
                "hover:bg-neutral-200"
              )}
              title="Close"
            >
              <X className="size-3.5 text-neutral-500 hover:text-neutral-700" />
            </Button>

            {/* Active tab che border-bottom của tab bar */}
            {isActive && (
              <div class="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 bg-white" />
            )}
          </div>
        );
      })}
    </div>
  );
}
