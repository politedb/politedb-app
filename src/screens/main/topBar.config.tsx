import {
  DateAscIcon,
  DateDescIcon,
  FolderIcon,
  RestoreIcon,
} from "src/components/icons";
import type { ConnectionSortMode, KeychainSortMode } from "src/types";
import type { DropdownItemConfig } from "src/components/common/Dropdown";

function alphaSortBadge(label: "Az" | "Za") {
  return (
    <span class="flex size-5 items-center justify-center rounded-md bg-slate-100 text-[10px] font-semibold text-slate-600">
      {label}
    </span>
  );
}

function selectedMark(active: boolean) {
  return active ? <span class="text-blue-600">✓</span> : undefined;
}

export function buildNewConnectionMenuItems(actions: {
  onNewGroup?: () => void;
  onImportConnections?: () => void;
}): DropdownItemConfig[] {
  return [
    {
      key: "import",
      label: "Import Connection",
      icon: <RestoreIcon className="size-4" />,
      onSelect: actions.onImportConnections,
    },
    {
      key: "new-group",
      label: "New Group",
      icon: <FolderIcon className="size-4" />,
      onSelect: actions.onNewGroup,
    },
  ];
}

export function buildConnectionSortItems(args: {
  mode: ConnectionSortMode;
  onChange?: (mode: ConnectionSortMode) => void;
}): DropdownItemConfig[] {
  const { mode, onChange } = args;

  return [
    {
      key: "label-asc",
      label: "A-z",
      icon: alphaSortBadge("Az"),
      rightSlot: selectedMark(mode === "label-asc"),
      onSelect: () => onChange?.("label-asc"),
    },
    {
      key: "label-desc",
      label: "Z-a",
      icon: alphaSortBadge("Za"),
      rightSlot: selectedMark(mode === "label-desc"),
      onSelect: () => onChange?.("label-desc"),
    },
    {
      key: "created-desc",
      label: "Newest to oldest",
      separatorBefore: true,
      icon: <DateDescIcon className="size-5" />,
      rightSlot: selectedMark(mode === "created-desc"),
      onSelect: () => onChange?.("created-desc"),
    },
    {
      key: "created-asc",
      label: "Oldest to newest",
      icon: <DateAscIcon className="size-5" />,
      rightSlot: selectedMark(mode === "created-asc"),
      onSelect: () => onChange?.("created-asc"),
    },
  ];
}

export function buildKeychainSortItems(args: {
  mode: KeychainSortMode;
  onChange?: (mode: KeychainSortMode) => void;
}): DropdownItemConfig[] {
  const { mode, onChange } = args;

  return [
    {
      key: "label-asc",
      label: "A-z",
      icon: alphaSortBadge("Az"),
      rightSlot: selectedMark(mode === "label-asc"),
      onSelect: () => onChange?.("label-asc"),
    },
    {
      key: "label-desc",
      label: "Z-a",
      icon: alphaSortBadge("Za"),
      rightSlot: selectedMark(mode === "label-desc"),
      onSelect: () => onChange?.("label-desc"),
    },
  ];
}

export function getTopBarSearchPlaceholder(isConnections: boolean) {
  return isConnections
    ? "Search connections or paste a URL..."
    : "Search keychain keys...";
}

export function getTopBarCreateLabel(isConnections: boolean) {
  return isConnections ? "New Connection" : "New Key";
}

export function getTopBarCreateTitle(isConnections: boolean) {
  return isConnections ? "Create" : "New keychain key";
}
