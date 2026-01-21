import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { cn } from "src/utils/cn";

export type MenuItem =
  | {
      type: "item";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      onClick: () => void;
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
    >
      <div class="py-1">
        {items.map((it, idx) => {
          if (it.type === "sep") {
            return <div key={idx} class="my-1 h-px bg-neutral-200/80" />;
          }

          const disabled = !!it.disabled;

          return (
            <button
              key={idx}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                it.onClick();
                onClose();
              }}
              class={cn(
                // tighter row height like native menus
                "mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-6",
                "rounded-md px-2.5 py-1.5 text-left text-[13px] leading-5",
                disabled
                  ? "text-neutral-400"
                  : [
                      "text-neutral-900",
                      // native-ish hover highlight (not too saturated)
                      "hover:bg-blue-600 hover:text-white",
                      "active:bg-blue-700",
                    ]
              )}
            >
              <span class="truncate">{it.label}</span>

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
            </button>
          );
        })}
      </div>
    </div>
  );
}
