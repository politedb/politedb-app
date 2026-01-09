import { JSX } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { cn } from "src/utils/cn";

type Align = "left" | "right";

export function MenuPopover(props: {
  open: boolean;
  onClose: () => void;

  // Either anchor to an element OR open at cursor position (context menu)
  anchorEl?: HTMLElement | null;
  point?: { x: number; y: number } | null;

  align?: Align; // for anchor mode
  width?: number; // px

  children: JSX.Element;
}) {
  const {
    open,
    onClose,
    anchorEl,
    point,
    align = "right",
    width = 220,
    children,
  } = props;
  const panelRef = useRef<HTMLDivElement>(null);

  // Click outside + ESC
  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    function onMouseDown(e: MouseEvent) {
      const el = panelRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, onClose]);

  const style = useMemo(() => {
    // Context menu: fixed at cursor
    if (point) {
      const pad = 8;
      const x = Math.max(pad, point.x);
      const y = Math.max(pad, point.y);
      return {
        position: "fixed",
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
      };
    }

    // Anchor menu: fixed near anchor
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      const top = r.bottom + 8;
      const left = align === "right" ? r.right - width : r.left;
      return {
        position: "fixed",
        left: `${Math.max(8, left)}px`,
        top: `${Math.max(8, top)}px`,
        width: `${width}px`,
      };
    }

    return { display: "none" };
  }, [anchorEl, point, align, width]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      style={style}
      class={cn(
        "z-1000 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg",
        "text-sm"
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function MenuItem(props: {
  children: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  right?: React.ReactNode;
}) {
  const { children, onClick, danger, disabled, right } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      class={cn(
        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
        danger
          ? "text-rose-700 hover:bg-rose-50"
          : "text-slate-700 hover:bg-slate-50",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <span class="truncate">{children}</span>
      {right ? <span class="shrink-0">{right}</span> : null}
    </button>
  );
}
