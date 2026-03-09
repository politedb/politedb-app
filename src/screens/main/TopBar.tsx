import type { TargetedEvent } from "preact";
import { Button } from "src/components/common/Button";
import { Grid, List, Plus, Search } from "src/components/icons";
import type { NavId, ViewMode } from "src/types";

export function TopBar(props: {
  mode: NavId;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onNew: () => void;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
}) {
  const { mode, searchQuery, onSearchChange, onNew, viewMode, onViewMode } =
    props;
  const isConnections = mode === "connections";
  const searchPlaceholder = isConnections
    ? "Search connections or paste a URL..."
    : "Search keychain keys...";
  const newLabel = isConnections ? "New Connection" : "New Key";
  const newTitle = isConnections ? "New connection" : "New keychain key";

  return (
    <div class="flex shrink-0 items-center gap-2 bg-white px-3 py-2">
      {/* Search */}
      <div class="relative min-w-0 flex-1">
        <input
          type="text"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onInput={(e: TargetedEvent<HTMLInputElement>) =>
            onSearchChange(e.currentTarget.value)
          }
          class="h-9 w-full rounded-lg border border-slate-300 bg-white py-2 pr-3 pl-9 text-[13px] text-slate-900 transition-colors outline-none placeholder:text-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </div>

      {/* Primary actions */}
      <Button
        variant="default"
        onClick={onNew}
        class="h-9 rounded-lg px-3"
        title={newTitle}
      >
        <Plus className="size-3.5" />
        <span class="text-[12px] font-semibold">{newLabel}</span>
      </Button>

      {/* View mode */}
      <div class="ml-1 flex items-center overflow-hidden rounded-lg border border-slate-300 bg-white">
        <button
          type="button"
          onClick={() => onViewMode("grid")}
          class={`flex h-9 w-9 items-center justify-center ${
            viewMode === "grid"
              ? "bg-blue-50 text-blue-600"
              : "text-slate-600 hover:bg-slate-50"
          }`}
          title="Grid view"
          aria-label="Grid view"
        >
          <Grid className="size-4" />
        </button>

        <div class="h-5 w-px bg-slate-200" />

        <button
          type="button"
          onClick={() => onViewMode("list")}
          class={`flex h-9 w-9 items-center justify-center ${
            viewMode === "list"
              ? "bg-blue-50 text-blue-600"
              : "text-slate-600 hover:bg-slate-50"
          }`}
          title="List view"
          aria-label="List view"
        >
          <List className="size-4" />
        </button>
      </div>
    </div>
  );
}
