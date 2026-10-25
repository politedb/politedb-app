/** Marks the sidebar rows (section headers and items) arrow keys move between. */
export const SIDEBAR_ITEM_ATTR = "data-sidebar-item";

const ITEM_SELECTOR = `[${SIDEBAR_ITEM_ATTR}]:not([disabled])`;

/**
 * List and menu navigation uses plain keys only: a chord such as Alt+Down
 * may be a shortcut (a snippet hotkey) and must not also move focus.
 */
export function hasModifier(e: KeyboardEvent) {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}

/** Opens a row's context menu under it, as a right-click would. */
function openContextMenuFor(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 16,
      clientY: rect.bottom,
    })
  );
}

/**
 * Keyboard use of a sidebar list (put on its scroll container): Up/Down,
 * Home/End move between rows; Shift+F10 or the Menu key opens a row's
 * context menu.
 */
export function handleSidebarListKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (!target?.matches?.(ITEM_SELECTOR)) return;

  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
    e.preventDefault();
    openContextMenuFor(target);
    return;
  }

  if (hasModifier(e)) return;
  const container = e.currentTarget as HTMLElement;
  const items = Array.from(
    container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)
  );
  const index = items.indexOf(target);
  const next =
    e.key === "ArrowDown"
      ? items[index + 1]
      : e.key === "ArrowUp"
        ? items[index - 1]
        : e.key === "Home"
          ? items[0]
          : e.key === "End"
            ? items[items.length - 1]
            : undefined;
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView?.({ block: "nearest" });
}
