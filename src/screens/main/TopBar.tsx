import type { JSX } from "preact";
import { Button } from "src/components/common/Button";
import { Console, Grid, List, Plus, Search } from "src/components/icons";
import type { ViewMode } from "src/types";

export function TopBar(props: {
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onNew: () => void;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
}) {
  const { searchQuery, onSearchChange, onNew, viewMode, onViewMode } = props;

  return (
    <div class="shrink-0 bg-neutral-50 shadow-md">
      <div class="p-2">
        <div class="relative">
          <input
            type="text"
            placeholder="Find a connection or postgres://user@hostname..."
            value={searchQuery}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) =>
              onSearchChange(e.currentTarget.value)
            }
            class="w-full rounded-lg border border-slate-300 bg-white py-2 pr-4 pl-10 text-[13px] text-slate-900 transition-colors placeholder:text-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
          <Search className="absolute top-1/2 left-3.5 h-5 w-5 -translate-y-1/2 text-slate-400" />
        </div>
      </div>

      <div class="flex items-center justify-between rounded-t-sm bg-slate-200 p-2 shadow-sm">
        <div class="flex items-center gap-2">
          <Button
            variant="default"
            onClick={onNew}
            class="rounded-md p-1.5 px-2"
          >
            <Plus className="size-3" />
            <span class="text-[11px] font-medium">NEW CONNECTION</span>
          </Button>

          <Button class="rounded-md p-1.5 px-2">
            <Console className="size-3.5" />
            <span class="text-[11px] font-medium">QUERY</span>
          </Button>
        </div>

        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => onViewMode("grid")}
            class={`rounded-lg bg-white p-2 ${
              viewMode === "grid"
                ? "border-blue-600 text-blue-600"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
            title="Grid View"
          >
            <Grid className="size-4" />
          </Button>

          <Button
            variant="outline"
            onClick={() => onViewMode("list")}
            class={`rounded-lg bg-white p-2 ${
              viewMode === "list"
                ? "border-blue-600 text-blue-600"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
            title="List View"
          >
            <List className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
