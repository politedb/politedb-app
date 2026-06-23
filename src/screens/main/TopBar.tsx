import type { TargetedEvent } from "preact";
import { useMemo, useState } from "preact/hooks";

import { Button } from "src/components/common/Button";
import { Dropdown } from "src/components/common/Dropdown";
import {
  ChevronDownIcon,
  GridIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  SortIcon,
} from "src/components/icons";
import type {
  ConnectionSortMode,
  KeychainSortMode,
  NavId,
  ViewMode,
} from "src/types";

import {
  buildConnectionSortItems,
  buildKeychainSortItems,
  buildNewConnectionMenuItems,
  getTopBarCreateLabel,
  getTopBarCreateTitle,
  getTopBarSearchPlaceholder,
} from "./topBar.config";
import { cn } from "src/utils/cn";

type TopBarProps = {
  mode: NavId;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onNewConnection: () => void;
  onNewGroup?: () => void;
  onImportConnections?: () => void;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
  connectionSortMode?: ConnectionSortMode;
  onConnectionSortModeChange?: (v: ConnectionSortMode) => void;
  keychainSortMode?: KeychainSortMode;
  onKeychainSortModeChange?: (v: KeychainSortMode) => void;
};

function SearchField(props: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const { value, placeholder, onChange } = props;

  return (
    <div class="relative min-w-0 flex-1">
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onInput={(e: TargetedEvent<HTMLInputElement>) =>
          onChange(e.currentTarget.value)
        }
        class={cn(
          "h-9 w-full rounded-lg border border-slate-300 bg-white py-2 pr-3 pl-9 text-sm text-slate-900 transition-colors",
          "outline-none placeholder:text-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        )}
      />
      <SearchIcon className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

function CreateConnectionButtonGroup(props: {
  label: string;
  title: string;
  onCreate: () => void;
  dropdownItems: ReturnType<typeof buildNewConnectionMenuItems>;
}) {
  const { label, title, onCreate, dropdownItems } = props;
  const [open, setOpen] = useState(false);

  return (
    <div class="flex items-center">
      <Button
        variant="default"
        className="h-9 rounded-lg rounded-r-none px-3"
        onClick={onCreate}
        title={title}
      >
        <PlusIcon className="size-3" />
        <span class="text-[12px] font-semibold">{label}</span>
      </Button>

      <Dropdown
        open={open}
        onOpenChange={setOpen}
        positions={["bottom", "right"]}
        align="end"
        items={dropdownItems}
        trigger={
          <div>
            <Button
              variant="default"
              className="h-9 rounded-lg rounded-l-none border-l border-l-neutral-300! px-3"
              onClick={() => setOpen((v) => !v)}
              title={title}
            >
              <ChevronDownIcon className="size-3" />
            </Button>
          </div>
        }
      />
    </div>
  );
}

function CreateKeychainButton(props: {
  label: string;
  title: string;
  onCreate: () => void;
}) {
  const { label, title, onCreate } = props;

  return (
    <Button
      variant="default"
      onClick={onCreate}
      class="h-9 rounded-lg px-3"
      title={title}
    >
      <PlusIcon className="size-3" />
      <span class="text-sm font-semibold">{label}</span>
    </Button>
  );
}

function SortMenu(props: {
  title: string;
  items:
    | ReturnType<typeof buildConnectionSortItems>
    | ReturnType<typeof buildKeychainSortItems>;
}) {
  const { title, items } = props;
  const [open, setOpen] = useState(false);

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      positions={["bottom"]}
      align="end"
      widthClassName="w-52"
      items={items}
      trigger={
        <div>
          <Button
            variant="outline"
            onClick={() => setOpen((v) => !v)}
            class="h-9 rounded-lg border border-slate-300 px-[8px]"
            title={title}
          >
            <SortIcon className="size-4" />
          </Button>
        </div>
      }
    />
  );
}

function UtilityActions(props: {
  sortTitle: string;
  sortItems:
    | ReturnType<typeof buildConnectionSortItems>
    | ReturnType<typeof buildKeychainSortItems>;
}) {
  const { sortTitle, sortItems } = props;

  return (
    <div class="flex items-center gap-1">
      <SortMenu title={sortTitle} items={sortItems} />
    </div>
  );
}

function ViewModeToggle(props: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const { mode, onChange } = props;

  return (
    <div class="flex items-center overflow-hidden rounded-lg border border-slate-300 bg-white">
      <button
        type="button"
        onClick={() => onChange("grid")}
        class={`flex h-9 w-9 items-center justify-center ${
          mode === "grid"
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
        onClick={() => onChange("list")}
        class={`flex h-9 w-9 items-center justify-center ${
          mode === "list"
            ? "bg-blue-50 text-blue-600"
            : "text-slate-600 hover:bg-slate-50"
        }`}
        title="List view"
        aria-label="List view"
      >
        <ListIcon className="size-4" />
      </button>
    </div>
  );
}

export function TopBar(props: TopBarProps) {
  const {
    mode,
    searchQuery,
    onSearchChange,
    onNewConnection,
    onNewGroup,
    onImportConnections,
    viewMode,
    onViewMode,
    connectionSortMode = "created-desc",
    onConnectionSortModeChange,
    keychainSortMode = "label-asc",
    onKeychainSortModeChange,
  } = props;

  const isConnections = mode === "connections";
  const isLogs = mode === "logs";
  const isUtilityMode = !isLogs;
  const searchPlaceholder = getTopBarSearchPlaceholder(mode);
  const createLabel = getTopBarCreateLabel(mode);
  const createTitle = getTopBarCreateTitle(mode);

  const newConnectionMenuItems = useMemo(
    () =>
      buildNewConnectionMenuItems({
        onNewGroup,
        onImportConnections,
      }),
    [onImportConnections, onNewGroup]
  );

  const sortItems = useMemo(
    () =>
      isConnections
        ? buildConnectionSortItems({
            mode: connectionSortMode,
            onChange: onConnectionSortModeChange,
          })
        : buildKeychainSortItems({
            mode: keychainSortMode,
            onChange: onKeychainSortModeChange,
          }),
    [
      connectionSortMode,
      isConnections,
      keychainSortMode,
      onConnectionSortModeChange,
      onKeychainSortModeChange,
    ]
  );

  return (
    <div class="flex h-[64px] w-full shrink-0 items-center gap-2 bg-white p-4">
      <SearchField
        value={searchQuery}
        placeholder={searchPlaceholder}
        onChange={onSearchChange}
      />

      {isUtilityMode ? (
        isConnections ? (
          <CreateConnectionButtonGroup
            label={createLabel}
            title={createTitle}
            onCreate={onNewConnection}
            dropdownItems={newConnectionMenuItems}
          />
        ) : (
          <CreateKeychainButton
            label={createLabel}
            title={createTitle}
            onCreate={onNewConnection}
          />
        )
      ) : null}

      {isUtilityMode ? (
        <>
          <UtilityActions
            sortTitle={
              isConnections ? "Sort connections" : "Sort keychain keys"
            }
            sortItems={sortItems}
          />

          <ViewModeToggle mode={viewMode} onChange={onViewMode} />
        </>
      ) : null}
    </div>
  );
}
