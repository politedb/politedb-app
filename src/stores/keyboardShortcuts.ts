import { create } from "zustand";

export type ShortcutActionId =
  | "openSearch"
  | "openSql"
  | "saveChanges"
  | "refresh"
  | "closeCurrent";

export type ShortcutBindings = Record<ShortcutActionId, string>;

export type ShortcutDefinition = {
  id: ShortcutActionId;
  label: string;
  description: string;
  defaultBinding: string;
};

const STORAGE_KEY = "politedb.keyboard-shortcuts.v1";

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "openSearch",
    label: "Open search",
    description: "Open the search dialog for tables and database objects.",
    defaultBinding: "Mod+K",
  },
  {
    id: "openSql",
    label: "New SQL editor",
    description: "Open a new SQL editor in the active connection tab.",
    defaultBinding: "Mod+T",
  },
  {
    id: "saveChanges",
    label: "Save changes",
    description: "Save current SQL or table changes.",
    defaultBinding: "Mod+S",
  },
  {
    id: "refresh",
    label: "Refresh",
    description: "Refresh the current view or schema metadata.",
    defaultBinding: "Mod+R",
  },
  {
    id: "closeCurrent",
    label: "Close current tab",
    description: "Close the active SQL editor, table tab, or connection tab.",
    defaultBinding: "Mod+W",
  },
];

const DEFAULT_SHORTCUTS = SHORTCUT_DEFINITIONS.reduce((acc, item) => {
  acc[item.id] = item.defaultBinding;
  return acc;
}, {} as ShortcutBindings);

type ShortcutStoreState = {
  shortcuts: ShortcutBindings;
  setShortcut: (id: ShortcutActionId, binding: string) => void;
  resetShortcut: (id: ShortcutActionId) => void;
  resetAll: () => void;
};

function canUseStorage() {
  return typeof window !== "undefined";
}

function readStoredShortcuts() {
  if (!canUseStorage()) return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredShortcuts(shortcuts: ShortcutBindings) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {
    // ignore localStorage failures
  }
}

function normalizeKeyToken(raw: string) {
  const value = raw.trim().toLowerCase();
  if (!value) return "";

  if (value === " ") return "Space";
  if (value === "esc") return "Escape";
  if (value === "return") return "Enter";
  if (value === "arrowup") return "ArrowUp";
  if (value === "arrowdown") return "ArrowDown";
  if (value === "arrowleft") return "ArrowLeft";
  if (value === "arrowright") return "ArrowRight";

  if (value.length === 1) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeBindingParts(parts: string[]) {
  const modifiers = new Set<string>();
  let key = "";

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const lower = part.toLowerCase();

    if (lower === "mod" || lower === "cmd" || lower === "command") {
      modifiers.add("Mod");
      continue;
    }
    if (lower === "ctrl" || lower === "control") {
      modifiers.add("Ctrl");
      continue;
    }
    if (lower === "alt" || lower === "option") {
      modifiers.add("Alt");
      continue;
    }
    if (lower === "shift") {
      modifiers.add("Shift");
      continue;
    }

    key = normalizeKeyToken(part);
  }

  const ordered = ["Mod", "Ctrl", "Alt", "Shift"].filter((token) =>
    modifiers.has(token)
  );
  return key ? [...ordered, key] : ordered;
}

export function normalizeShortcutBinding(binding: string) {
  return normalizeBindingParts(binding.split("+")).join("+");
}

function loadShortcuts(): ShortcutBindings {
  const raw = readStoredShortcuts();
  if (!raw) return DEFAULT_SHORTCUTS;

  try {
    const parsed = JSON.parse(raw) as Partial<ShortcutBindings>;
    const next = { ...DEFAULT_SHORTCUTS };
    for (const item of SHORTCUT_DEFINITIONS) {
      const value = parsed[item.id];
      if (typeof value === "string" && value.trim()) {
        next[item.id] = normalizeShortcutBinding(value);
      }
    }
    return next;
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

export function isMacPlatform() {
  if (typeof navigator === "undefined") return true;
  return navigator.platform.toLowerCase().includes("mac");
}

export function formatShortcutLabel(
  binding: string,
  options?: { isMac?: boolean }
) {
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized) return "";

  const isMac = options?.isMac ?? isMacPlatform();
  const parts = normalized.split("+");
  const key = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);

  if (isMac) {
    const prefix = modifiers
      .map((part) => {
        if (part === "Mod") return "⌘";
        if (part === "Ctrl") return "^";
        if (part === "Alt") return "⌥";
        if (part === "Shift") return "⇧";
        return part;
      })
      .join("");
    return `${prefix} + ${key}`;
  }

  return [...modifiers.map((part) => (part === "Mod" ? "Ctrl" : part)), key]
    .filter(Boolean)
    .join("+");
}

export function keyboardEventToShortcut(event: KeyboardEvent) {
  const isMac = isMacPlatform();
  const parts: string[] = [];

  if (isMac) {
    if (event.metaKey) {
      parts.push("Mod");
    }
    if (event.ctrlKey) {
      parts.push("Ctrl");
    }
  } else if (event.ctrlKey) {
    parts.push("Mod");
  }

  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }

  const key = normalizeKeyToken(event.key);
  if (
    !key ||
    key === "Meta" ||
    key === "Control" ||
    key === "Alt" ||
    key === "Shift"
  ) {
    return "";
  }

  if (parts.length === 0) return "";
  return normalizeBindingParts([...parts, key]).join("+");
}

export function matchesShortcut(event: KeyboardEvent, binding: string) {
  return keyboardEventToShortcut(event) === normalizeShortcutBinding(binding);
}

export const useKeyboardShortcutsStore = create<ShortcutStoreState>((set) => ({
  shortcuts: loadShortcuts(),
  setShortcut: (id, binding) =>
    set((state) => {
      const next = {
        ...state.shortcuts,
        [id]: normalizeShortcutBinding(binding),
      };
      writeStoredShortcuts(next);
      return { shortcuts: next };
    }),
  resetShortcut: (id) =>
    set((state) => {
      const next = {
        ...state.shortcuts,
        [id]: DEFAULT_SHORTCUTS[id],
      };
      writeStoredShortcuts(next);
      return { shortcuts: next };
    }),
  resetAll: () => {
    writeStoredShortcuts(DEFAULT_SHORTCUTS);
    set({ shortcuts: DEFAULT_SHORTCUTS });
  },
}));
