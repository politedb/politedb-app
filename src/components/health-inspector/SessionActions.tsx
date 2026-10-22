import { useEffect, useId, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { SessionActionKind } from "src/lib/tauri/health-inspector-actions";
import type { SessionActionEligibility } from "src/lib/health-inspector/sessionActions";
import { cn } from "src/utils/cn";

const MENU_WIDTH = 190;

type MenuItem = {
  kind: SessionActionKind;
  label: string;
  enabled: boolean;
  hint: string | null;
};

/**
 * Row action menu for one session: Cancel query / Terminate session.
 * Keyboard: opening focuses the first enabled item; Up/Down/Home/End move;
 * Enter/Space activate; Tab closes and continues; Escape closes the menu only
 * (consumed before the Dialog's own Escape) and returns focus to the trigger.
 */
export function SessionActions(props: {
  pid: number;
  eligibility: SessionActionEligibility;
  /** Another action is in progress, or this row awaits a fresh snapshot. */
  disabled: boolean;
  disabledReason?: string | null;
  onAction: (kind: SessionActionKind) => void;
  /** Focus target when this row disappears while focus is inside it. */
  onFocusLost?: () => void;
}) {
  const { eligibility, pid } = props;
  const triggerId = useId();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusWithinRef = useRef(false);
  const onFocusLostRef = useRef(props.onFocusLost);
  onFocusLostRef.current = props.onFocusLost;
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const open = position !== null;

  const items: MenuItem[] = [
    {
      kind: "cancel",
      label: "Cancel query",
      enabled: eligibility.cancel,
      hint: eligibility.cancel ? null : "Only for active sessions",
    },
    {
      kind: "terminate",
      label: "Terminate session",
      enabled: eligibility.terminate,
      hint: null,
    },
  ];

  const menuButtons = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not([aria-disabled="true"])'
      ) ?? []
    );

  const close = (restoreFocus: boolean) => {
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(
        8,
        Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)
      ),
      top: rect.bottom + 4,
    });
  };

  // Focus the first enabled item once the menu is in the DOM.
  useEffect(() => {
    if (open) menuButtons()[0]?.focus();
  }, [open]);

  // While open: Escape (capture, before the Dialog), outside clicks, scrolling.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        close(false);
      }
    };
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // The row can vanish after a refresh; do not strand keyboard focus.
  useEffect(
    () => () => {
      if (focusWithinRef.current) onFocusLostRef.current?.();
    },
    []
  );

  if (eligibility.ownedByThisApp) {
    return (
      <span
        class="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        title="Sessions opened by this app are never cancelled or terminated from here"
      >
        This app
      </span>
    );
  }
  if (!eligibility.cancel && !eligibility.terminate) {
    return (
      <span
        class="text-xs text-neutral-400"
        title={eligibility.reason ?? undefined}
        aria-label={eligibility.reason ?? "No actions"}
        role="img"
      >
        —
      </span>
    );
  }

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const buttons = menuButtons();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (i: number) => {
      event.preventDefault();
      buttons[(i + buttons.length) % buttons.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return focusAt(index + 1);
      case "ArrowUp":
        return focusAt(index - 1);
      case "Home":
        return focusAt(0);
      case "End":
        return focusAt(buttons.length - 1);
      case "Tab":
        // The menu is portalled; move focus back to the trigger first so the
        // browser's Tab/Shift+Tab continues from the row, then close.
        triggerRef.current?.focus();
        close(false);
        return;
    }
  };

  return (
    <span
      onFocusIn={() => (focusWithinRef.current = true)}
      onFocusOut={() => (focusWithinRef.current = false)}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-label={`Actions for PID ${pid}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-disabled={props.disabled || undefined}
        title={props.disabled ? (props.disabledReason ?? undefined) : undefined}
        onClick={() => {
          if (props.disabled) return;
          if (open) close(false);
          else openMenu();
        }}
        class={cn(
          "inline-flex h-6 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
          props.disabled && "cursor-not-allowed opacity-50"
        )}
      >
        <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="13" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-labelledby={triggerId}
              onKeyDown={onMenuKeyDown}
              onFocusIn={() => (focusWithinRef.current = true)}
              onFocusOut={() => (focusWithinRef.current = false)}
              class="fixed z-[1100] rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
              style={{
                left: position.left,
                top: position.top,
                width: MENU_WIDTH,
              }}
            >
              {items.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={!item.enabled || undefined}
                  title={item.hint ?? undefined}
                  onClick={() => {
                    if (!item.enabled) return;
                    close(true);
                    props.onAction(item.kind);
                  }}
                  class={cn(
                    "block w-full px-3 py-1.5 text-left text-sm outline-none focus:bg-neutral-100 dark:focus:bg-neutral-800",
                    item.kind === "terminate"
                      ? "text-red-700 dark:text-red-300"
                      : "text-neutral-800 dark:text-neutral-100",
                    !item.enabled && "cursor-not-allowed opacity-50"
                  )}
                >
                  {item.label}
                  {item.hint ? (
                    <span class="block text-xs text-neutral-500">
                      {item.hint}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}
