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

export function ContextMenu(props: {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const { open, x, y, items, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);

  useEffect(() => {
    if (!open) setActiveSubmenu(null);
  }, [open]);

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
        "shadow-[0_10px_24px_rgba(0,0,0,0.14)]"
      )}
      style={{ left: x, top: y }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div class="py-1">
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
                  "rounded-md px-2.5 py-1.5 text-left text-[13px] leading-5",
                  activeSubmenu === idx && hasSubmenu
                    ? "bg-blue-600 text-white"
                    : it.color
                      ? `text-${it.color}-700 hover:bg-${it.color}-50 active:bg-${it.color}-100`
                      : "text-neutral-900 hover:bg-blue-600 hover:text-white active:bg-blue-700",
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
                      <button
                        key={subIdx}
                        type="button"
                        disabled={subDisabled}
                        onClick={() => {
                          if (subDisabled) return;
                          sub.onClick?.();
                          onClose();
                        }}
                        class={cn(
                          "mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left text-[13px] leading-5",
                          sub.color
                            ? `text-${sub.color}-700 hover:bg-${sub.color}-50 active:bg-${sub.color}-100`
                            : "text-neutral-900 hover:bg-blue-600 hover:text-white active:bg-blue-700",
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
