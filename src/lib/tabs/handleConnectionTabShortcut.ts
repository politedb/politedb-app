import { isModalDialogOpen } from "src/lib/settings/openSettings";
import { useScreenStore } from "src/stores/screen";
import { connectionTabShortcutTarget } from "./connectionTabShortcuts";

/**
 * Switches connection tabs for ⌘1…9 / Ctrl+Tab. Returns whether the key was
 * one of them (it is then consumed, even when a dialog or menu is open and
 * nothing switches, so it never leaves that dialog or menu behind).
 */
export function handleConnectionTabShortcut(
  event: KeyboardEvent,
  isMac: boolean
): boolean {
  const { profileTabs, activeProfileScreen, setActiveProfileScreen } =
    useScreenStore.getState();
  const target = connectionTabShortcutTarget(
    event,
    isMac,
    profileTabs.map((tab) => tab.id),
    activeProfileScreen
  );
  if (!target) return false;
  event.preventDefault();
  if (!isModalDialogOpen()) setActiveProfileScreen(target);
  return true;
}
