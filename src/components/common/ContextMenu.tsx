import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { cn } from "src/utils/cn";

export type MenuItem =
  | {
      type: "item";
      label: string;
      color?: string;
      icon?: JSX.Element;
      shortcut?: string;
      disabled?: boolean;
      onClick?: () => void;
      submenu?: MenuItem[];
    }
  | { type: "sep" };

/** Keyboard focus look for colored items (written out so Tailwind keeps it). */
function colorFocusClass(color: string) {
  return color === "red"
    ? "focus-visible:bg-red-50"
    : "focus-visible:bg-neutral-100";
}

const ITEM_SELECTOR = "button[data-menu-item]:not([disabled])";

/** Moves focus among a menu level's enabled items (wrapping). */
function focusSibling(level: Element, from: Element | null, step: number) {
  const items = Array.from(
    level.querySelectorAll<HTMLButtonElement>(`:scope > div > ${ITEM_SELECTOR}`)
  );
  if (!items.length) return;
  const index = from ? items.indexOf(from as HTMLButtonElement) : -1;
  const next =
    step === Infinity
      ? items[items.length - 1]
      : step === -Infinity
        ? items[0]
        : items[(index + step + items.length) % items.length];
  next?.focus();
}

export function ContextMenu(props: {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  class?: string;
  /**
   * Focus the first item when it opens (and give focus back when it
   * closes), so it can be used from the keyboard.
   */
  autoFocus?: boolean;
}) {
  const { open, x, y, items, onClose, autoFocus = false } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) setActiveSubmenu(null);
  }, [open]);

  // Keyboard use: focus the first item on open, give focus back on close.
  useEffect(() => {
    if (!open || !autoFocus) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    const level = ref.current?.querySelector("[data-menu-level]");
    if (level) focusSibling(level, null, 1);
    return () => {
      const opener = openerRef.current;
      const active = document.activeElement;
      if (
        opener?.isConnected &&
        (!active || active === document.body || ref.current?.contains(active))
      ) {
        opener.focus();
      }
    };
  }, [open, autoFocus]);

  const onMenuKeyDown = (e: KeyboardEvent) => {
    // Plain keys only: a chord may be an app shortcut.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    const level = target.closest("[data-menu-level]");
    if (!level) return;
    const steps: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      Home: -Infinity,
      End: Infinity,
    };
    if (e.key in steps) {
      e.preventDefault();
      focusSibling(level, target, steps[e.key]!);
      return;
    }
    const index = Number(target.dataset.menuIndex);
    if (e.key === "ArrowRight" && target.dataset.hasSubmenu) {
      e.preventDefault();
      setActiveSubmenu(index);
      requestAnimationFrame(() => {
        const sub = ref.current?.querySelector(
          `[data-menu-level="sub-${index}"]`
        );
        if (sub) focusSibling(sub, null, 1);
      });
      return;
    }
    if (
      e.key === "ArrowLeft" &&
      level.getAttribute("data-menu-level") !== "root"
    ) {
      e.preventDefault();
      const parentIndex = Number(
        level.getAttribute("data-menu-level")!.slice(4)
      );
      setActiveSubmenu(null);
      ref.current
        ?.querySelector<HTMLElement>(`[data-menu-index="${parentIndex}"]`)
        ?.focus();
    }
  };

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const onMouseDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;

    const pad = 8;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (left + r.width > vw - pad) left = Math.max(pad, vw - pad - r.width);
    if (top + r.height > vh - pad) top = Math.max(pad, vh - pad - r.height);

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [open, x, y]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      class={cn(
        "fixed z-9999 min-w-56 select-none",
        // flatter container
        "rounded-lg border border-neutral-200 bg-white",
        // lighter shadow (more native)
        "shadow-[0_10px_24px_rgba(0,0,0,0.14)]",
        props.class
      )}
      style={{ left: x, top: y }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      <div class="py-1" data-menu-level="root">
        {items.map((it, idx) => {
          if (it.type === "sep") {
            return <div key={idx} class="my-1 h-px bg-neutral-200/80" />;
          }

          const disabled = !!it.disabled;
          const hasSubmenu = !!it.submenu?.length;

          return (
            <div key={idx} class="relative">
              <button
                type="button"
                role="menuitem"
                data-menu-item
                data-menu-index={idx}
                data-has-submenu={hasSubmenu ? "true" : undefined}
                aria-haspopup={hasSubmenu ? "menu" : undefined}
                aria-expanded={hasSubmenu ? activeSubmenu === idx : undefined}
                disabled={disabled}
                onMouseEnter={() => setActiveSubmenu(hasSubmenu ? idx : null)}
                onClick={() => {
                  if (disabled) return;
                  if (hasSubmenu) {
                    setActiveSubmenu(idx);
                    return;
                  }
                  it.onClick?.();
                  onClose();
                }}
                class={cn(
                  // tighter row height like native menus
                  "mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-6",
                  "rounded-md px-2.5 py-1.5 text-left text-[13px] leading-5 outline-none",
                  activeSubmenu === idx && hasSubmenu
                    ? "bg-blue-600 text-white"
                    : it.color
                      ? cn(
                          `text-${it.color}-700 hover:bg-${it.color}-50 active:bg-${it.color}-100`,
                          colorFocusClass(it.color)
                        )
                      : "text-neutral-900 hover:bg-blue-600 hover:text-white focus-visible:bg-blue-600 focus-visible:text-white active:bg-blue-700",
                  disabled &&
                    "text-neutral-500 opacity-50 hover:bg-transparent hover:text-neutral-500 active:bg-transparent active:text-neutral-500"
                )}
              >
                <div class="flex min-w-0 items-center gap-2">
                  {it.icon ? <span class="shrink-0">{it.icon}</span> : null}
                  <span class="truncate">{it.label}</span>
                </div>

                <span class="flex shrink-0 items-center gap-3">
                  {it.shortcut ? (
                    <span
                      class={cn(
                        "text-[12px] tabular-nums",
                        disabled ? "text-neutral-300" : "opacity-80"
                      )}
                    >
                      {it.shortcut}
                    </span>
                  ) : null}
                  {hasSubmenu ? (
                    <span class="text-[15px] leading-none">›</span>
                  ) : null}
                </span>
              </button>

              {hasSubmenu && activeSubmenu === idx ? (
                <div
                  role="menu"
                  data-menu-level={`sub-${idx}`}
                  class={cn(
                    "absolute top-0 left-full z-9999 ml-1 min-w-40 rounded-lg border border-neutral-200 bg-white py-1",
                    "shadow-[0_10px_24px_rgba(0,0,0,0.14)]"
                  )}
                  onMouseEnter={() => setActiveSubmenu(idx)}
                >
                  {it.submenu!.map((sub, subIdx) => {
                    if (sub.type === "sep") {
                      return (
                        <div key={subIdx} class="my-1 h-px bg-neutral-200/80" />
                      );
                    }
                    const subDisabled = !!sub.disabled;
                    return (
                      <div key={subIdx}>
                        <button
                          type="button"
                          role="menuitem"
                          data-menu-item
                          disabled={subDisabled}
                          onClick={() => {
                            if (subDisabled) return;
                            sub.onClick?.();
                            onClose();
                          }}
                          class={cn(
                            "mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left text-[13px] leading-5 outline-none",
                            sub.color
                              ? cn(
                                  `text-${sub.color}-700 hover:bg-${sub.color}-50 active:bg-${sub.color}-100`,
                                  colorFocusClass(sub.color)
                                )
                              : "text-neutral-900 hover:bg-blue-600 hover:text-white focus-visible:bg-blue-600 focus-visible:text-white active:bg-blue-700",
                            subDisabled &&
                              "text-neutral-500 opacity-50 hover:bg-transparent hover:text-neutral-500 active:bg-transparent active:text-neutral-500"
                          )}
                        >
                          <div class="flex min-w-0 items-center gap-2">
                            {sub.icon ? (
                              <span class="shrink-0">{sub.icon}</span>
                            ) : null}
                            <span class="truncate">{sub.label}</span>
                          </div>
                          {sub.shortcut ? (
                            <span
                              class={cn(
                                "text-[12px] tabular-nums",
                                subDisabled ? "text-neutral-300" : "opacity-80"
                              )}
                            >
                              {sub.shortcut}
                            </span>
                          ) : null}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
