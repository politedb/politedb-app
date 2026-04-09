import type { TargetedEvent } from "preact";
import { useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Dropdown } from "src/components/common/Dropdown";
import {
  ChevronDownIcon,
  DateAscIcon,
  DateDescIcon,
  FolderIcon,
  GridIcon,
  ListIcon,
  PlusIcon,
  RestoreIcon,
  SearchIcon,
  SettingsIcon,
  SortIcon,
} from "src/components/icons";
import type { ConnectionSortMode, NavId, ViewMode } from "src/types";

export function TopBar(props: {
  mode: NavId;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onNewConnection: () => void;
  onNewGroup?: () => void;
  onImportConnections?: () => void;
  onPrivacy: () => void;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
  connectionSortMode?: ConnectionSortMode;
  onConnectionSortModeChange?: (v: ConnectionSortMode) => void;
}) {
  const {
    mode,
    searchQuery,
    onSearchChange,
    onNewConnection,
    onNewGroup,
    onImportConnections,
    onPrivacy,
    viewMode,
    onViewMode,
    connectionSortMode = "created-desc",
    onConnectionSortModeChange,
  } = props;
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const isConnections = mode === "connections";
  const searchPlaceholder = isConnections
    ? "Search connections or paste a URL..."
    : "Search keychain keys...";
  const newLabel = isConnections ? "New Connection" : "New Key";
  const newTitle = isConnections ? "Create" : "New keychain key";

  return (
    <div class="flex shrink-0 items-center gap-2 bg-white px-1 py-2">
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
        <SearchIcon className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </div>

      {/* Primary actions */}
      {isConnections ? (
        <div class="flex items-center">
          <Button
            variant="default"
            className="h-9 rounded-lg rounded-r-none px-3"
            onClick={onNewConnection}
            title={newTitle}
          >
            <PlusIcon className="size-3" />
            <span class="text-[12px] font-semibold">{newLabel}</span>
          </Button>

          <Dropdown
            open={newMenuOpen}
            onOpenChange={setNewMenuOpen}
            positions={["bottom", "right"]}
            align="end"
            items={[
              {
                key: "new-group",
                label: "New Group",
                icon: <FolderIcon className="size-4" />,
                onSelect: onNewGroup,
              },
              {
                key: "import",
                label: "Import",
                icon: <RestoreIcon className="size-4" />,
                onSelect: onImportConnections,
              },
            ]}
            trigger={
              <div>
                <Button
                  variant="default"
                  className="h-9 rounded-lg rounded-l-none border-l border-l-neutral-300! px-3"
                  onClick={() => setNewMenuOpen((v) => !v)}
                  title={newTitle}
                >
                  <ChevronDownIcon className="size-3" />
                </Button>
              </div>
            }
          />
        </div>
      ) : (
        <Button
          variant="default"
          onClick={onNewConnection}
          class="h-9 rounded-lg px-3"
          title={newTitle}
        >
          <PlusIcon className="size-3" />
          <span class="text-sm font-semibold">{newLabel}</span>
        </Button>
      )}

      <div class="flex items-center gap-1">
        {isConnections ? (
          <Dropdown
            open={sortMenuOpen}
            onOpenChange={setSortMenuOpen}
            positions={["bottom"]}
            align="end"
            widthClassName="w-52"
            items={[
              {
                key: "label-asc",
                label: "A-z",
                icon: (
                  <span class="flex size-5 items-center justify-center rounded-md bg-slate-100 text-[10px] font-semibold text-slate-600">
                    Az
                  </span>
                ),
                rightSlot:
                  connectionSortMode === "label-asc" ? (
                    <span class="text-blue-600">✓</span>
                  ) : undefined,
                onSelect: () => onConnectionSortModeChange?.("label-asc"),
              },
              {
                key: "label-desc",
                label: "Z-a",
                icon: (
                  <span class="flex size-5 items-center justify-center rounded-md bg-slate-100 text-[10px] font-semibold text-slate-600">
                    Za
                  </span>
                ),
                rightSlot:
                  connectionSortMode === "label-desc" ? (
                    <span class="text-blue-600">✓</span>
                  ) : undefined,
                onSelect: () => onConnectionSortModeChange?.("label-desc"),
              },
              {
                key: "created-desc",
                label: "Newest to oldest",
                separatorBefore: true,
                icon: <DateDescIcon className="size-5" />,
                rightSlot:
                  connectionSortMode === "created-desc" ? (
                    <span class="text-blue-600">✓</span>
                  ) : undefined,
                onSelect: () => onConnectionSortModeChange?.("created-desc"),
              },
              {
                key: "created-asc",
                label: "Oldest to newest",
                icon: <DateAscIcon className="size-5" />,
                rightSlot:
                  connectionSortMode === "created-asc" ? (
                    <span class="text-blue-600">✓</span>
                  ) : undefined,
                onSelect: () => onConnectionSortModeChange?.("created-asc"),
              },
            ]}
            trigger={
              <div>
                <Button
                  variant="outline"
                  onClick={() => setSortMenuOpen((v) => !v)}
                  class="h-9 rounded-lg border border-slate-300 px-[8px]"
                  title="Sort connections"
                >
                  <SortIcon className="size-4" />
                </Button>
              </div>
            }
          />
        ) : null}
        <Button
          variant="outline"
          onClick={onPrivacy}
          class="h-9 rounded-lg border border-slate-300 px-[8px]"
          title="Privacy Settings"
        >
          <SettingsIcon className="size-4" />
        </Button>
      </div>

      {/* View mode */}
      <div class="flex items-center overflow-hidden rounded-lg border border-slate-300 bg-white">
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
          <GridIcon className="size-4" />
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
          <ListIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
