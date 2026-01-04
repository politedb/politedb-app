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
    <div class="bg-neutral-50 shadow-md shrink-0">
      <div class="p-2">
        <div class="relative">
          <input
            type="text"
            placeholder="Find a connection or postgres://user@hostname..."
            value={searchQuery}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) =>
              onSearchChange(e.currentTarget.value)
            }
            class="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-300 bg-white text-[13px] text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-colors"
          />
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        </div>
      </div>

      <div class="p-2 rounded-t-sm bg-slate-200 flex items-center justify-between shadow-sm">
        <div class="flex items-center gap-2">
          <Button
            variant="default"
            onClick={onNew}
            class="p-1.5 px-2 rounded-md"
          >
            <Plus className="size-3" />
            <span class="text-[11px] font-medium">NEW CONNECTION</span>
          </Button>

          <Button class="p-1.5 px-2 rounded-md">
            <Console className="size-3.5" />
            <span class="text-[11px] font-medium">QUERY</span>
          </Button>
        </div>

        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => onViewMode("grid")}
            class={`p-2 rounded-lg bg-white ${
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
            class={`p-2 rounded-lg bg-white ${
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
