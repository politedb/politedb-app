import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

type ConfirmVariant = "default" | "danger";

export function ConfirmPopover(props: {
  // trigger
  children: (api: {
    open: () => void;
    close: () => void;
    isOpen: boolean;
  }) => JSX.Element;

  // content
  title?: string;
  description?: string;

  // buttons
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;

  // behavior
  disabled?: boolean;
  confirmDisabled?: boolean;
  closeOnConfirm?: boolean; // default true
  closeOnCancel?: boolean; // default true
  closeOnOutside?: boolean; // default true
  closeOnEsc?: boolean; // default true

  // callbacks
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
    onConfirm,
    onCancel,
  } = props;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  function apiOpen() {
    if (disabled) return;
    setOpen(true);
  }
  function apiClose() {
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    function onDocMouseDown(e: MouseEvent) {
      if (!closeOnOutside) return;
      const el = rootRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!closeOnEsc) return;
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, closeOnOutside, closeOnEsc]);

  const confirmBtnClass =
    variant === "danger"
      ? "bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
      : "bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60";

  return (
    <div ref={rootRef} class="relative inline-block">
      {children({ open: apiOpen, close: apiClose, isOpen: open })}

      {open && (
        <div
          class="absolute right-0 z-50 mt-2 w-56 rounded-lg border border-slate-200 bg-white shadow-lg"
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
        </div>
      )}
    </div>
  );
}
