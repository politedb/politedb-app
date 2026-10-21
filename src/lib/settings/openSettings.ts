/**
 * Opening Settings from anywhere (⌘, on macOS, Ctrl+, elsewhere). The dialog
 * lives on the main screen, which is not mounted while a connection tab is
 * open, so a request is kept until the main screen picks it up.
 */
export const OPEN_SETTINGS_EVENT = "politedb-open-settings";

let pending = false;

export function requestOpenSettings() {
  pending = true;
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}

/** True once per request; the main screen calls it when it mounts or hears the event. */
export function takeOpenSettingsRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}

/** ⌘, on macOS, Ctrl+, elsewhere; no other modifiers. */
export function isOpenSettingsShortcut(event: KeyboardEvent, isMac: boolean) {
  if (event.key !== ",") return false;
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const other = isMac ? event.ctrlKey : event.metaKey;
  return primary && !other && !event.altKey && !event.shiftKey;
}

/**
 * Whether a modal dialog or a menu is open. Settings then waits instead of
 * stacking: a dialog keeps its draft, and a menu could open another dialog
 * over or under Settings.
 */
export function isModalDialogOpen(doc: Document = document): boolean {
  return !!doc.querySelector('[aria-modal="true"], [role="menu"]');
}
