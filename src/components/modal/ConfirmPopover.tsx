import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { createPortal } from "preact/compat";

type ConfirmVariant = "default" | "danger";
type ConfirmAlign = "start" | "center" | "end";

type Point = { top: number; left: number; placement: "top" | "bottom" };

export function ConfirmPopover(props: {
  children: (api: {
    open: () => void;
    close: () => void;
    isOpen: boolean;
    triggerRef: (el: HTMLElement | null) => void;
  }) => JSX.Element;

  title?: string;
  description?: string;

  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;

  disabled?: boolean;
  confirmDisabled?: boolean;
  closeOnConfirm?: boolean;
  closeOnCancel?: boolean;
  closeOnOutside?: boolean;
  closeOnEsc?: boolean;
  align?: ConfirmAlign;

  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const {
    children,
    title = "Are you sure?",
    description,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "default",
    disabled = false,
    confirmDisabled = false,
    closeOnConfirm = true,
    closeOnCancel = true,
    closeOnOutside = true,
    closeOnEsc = true,
    align = "end",
    onConfirm,
    onCancel,
  } = props;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<Point | null>(null);

  const triggerElRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  function setTriggerEl(el: HTMLElement | null) {
    triggerElRef.current = el;
  }

  function apiOpen() {
    if (disabled) return;
    setOpen(true);
  }
  function apiClose() {
    setOpen(false);
  }

  // compute position when open
  useLayoutEffect(() => {
    if (!open) return;

    const el = triggerElRef.current;
    if (!el) return;

    const r = el.getBoundingClientRect();

    // default: open below
    const W = 240; // popover width
    const GAP = 8;

    let left =
      align === "start"
        ? r.left
        : align === "center"
          ? r.left + r.width / 2 - W / 2
          : r.right - W;

    left = Math.min(Math.max(8, left), window.innerWidth - W - 8);

    let top = r.bottom + GAP;
    let placement: Point["placement"] = "bottom";

    // flip up if near bottom
    const estimatedH = 110; // approximate popover height
    if (top + estimatedH > window.innerHeight - 8) {
      top = Math.max(8, r.top - GAP - estimatedH);
      placement = "top";
    }

    setPos({ top, left, placement });
  }, [open]);

  // outside / esc
  useEffect(() => {
    if (!open) return;

    function onDocMouseDown(e: MouseEvent) {
      if (!closeOnOutside) return;

      const pop = popoverRef.current;
      const trg = triggerElRef.current;
      const t = e.target as Node;

      // click inside popover or trigger => ignore
      if ((pop && pop.contains(t)) || (trg && trg.contains(t))) return;

      setOpen(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!closeOnEsc) return;
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDocMouseDown, true); // capture to beat menus
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", apiClose);
    window.addEventListener("scroll", apiClose, true);

    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", apiClose);
      window.removeEventListener("scroll", apiClose, true);
    };
  }, [open, closeOnOutside, closeOnEsc]);

  const confirmBtnClass =
    variant === "danger"
      ? "bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
      : "bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60";

  return (
    <>
      {children({
        open: apiOpen,
        close: apiClose,
        isOpen: open,
        triggerRef: setTriggerEl,
      })}

      {open && pos
        ? createPortal(
            <div
              ref={popoverRef}
              class="fixed z-9999 w-60 rounded-lg border border-slate-200 bg-white shadow-lg"
              style={{ top: pos.top, left: pos.left }}
              onMouseDown={(e) => e.stopPropagation()} // don’t bubble to card/menu
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div class="px-3 py-2">
                <div class="text-sm font-medium text-slate-900">{title}</div>
                {description ? (
                  <div class="mt-1 text-xs text-slate-600">{description}</div>
                ) : null}
              </div>

              <div class="flex justify-end gap-2 px-3 pb-3">
                <button
                  type="button"
                  class="rounded px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => {
                    if (closeOnCancel) setOpen(false);
                    onCancel?.();
                  }}
                >
                  {cancelText}
                </button>

                <button
                  type="button"
                  class={`rounded px-2 py-1 text-xs ${confirmBtnClass}`}
                  disabled={busy || confirmDisabled}
                  onClick={async () => {
                    try {
                      setBusy(true);
                      await onConfirm();
                      if (closeOnConfirm) setOpen(false);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "..." : confirmText}
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
