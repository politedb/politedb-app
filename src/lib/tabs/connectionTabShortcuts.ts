/**
 * App-wide keys that switch connection tabs, like a browser's:
 * ⌘1…⌘8 (Ctrl+1…8 elsewhere) pick a tab by position and ⌘9 the last one;
 * Ctrl+Tab and Ctrl+Shift+Tab go to the next and previous tab, wrapping.
 */

/** Bindings reserved for these keys, so no action or snippet can take them. */
export const CONNECTION_TAB_SHORTCUTS: Record<string, string> = {
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`Mod+${i + 1}`, "a connection tab"])
  ),
  "Ctrl+Tab": "the next connection tab",
  "Ctrl+Shift+Tab": "the previous connection tab",
  // Ctrl is Mod outside macOS.
  "Mod+Tab": "the next connection tab",
  "Mod+Shift+Tab": "the previous connection tab",
};

/** The tab a key press switches to, or null when it is not such a key. */
export function connectionTabShortcutTarget(
  event: KeyboardEvent,
  isMac: boolean,
  tabIds: string[],
  activeId: string
): string | null {
  if (tabIds.length === 0 || event.altKey) return null;

  const primary = isMac ? event.metaKey : event.ctrlKey;
  const other = isMac ? event.ctrlKey : event.metaKey;
  if (primary && !other && !event.shiftKey && /^[1-9]$/.test(event.key)) {
    const n = Number(event.key);
    if (n === 9) return tabIds[tabIds.length - 1]!;
    return tabIds[n - 1] ?? null;
  }

  if (event.key === "Tab" && event.ctrlKey && !event.metaKey) {
    const index = tabIds.indexOf(activeId);
    const step = event.shiftKey ? -1 : 1;
    if (index < 0) return step > 0 ? tabIds[0]! : tabIds[tabIds.length - 1]!;
    return tabIds[(index + step + tabIds.length) % tabIds.length]!;
  }

  return null;
}

/** The ⌘n / Ctrl+n hint for the tab at this position, if it has one. */
export function connectionTabShortcutHint(
  index: number,
  count: number,
  isMac: boolean
): string | null {
  const digit = index < 8 ? index + 1 : index === count - 1 ? 9 : null;
  if (digit == null) return null;
  return isMac ? `⌘${digit}` : `Ctrl+${digit}`;
}
