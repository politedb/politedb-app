import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { X } from "../icons";
import { cn } from "../../utils/cn";

export type DialogSize = "xs" | "sm" | "md" | "lg" | "xl" | "full";

interface DialogProps {
  open: boolean;
  onClose?: () => void;
  children: ComponentChildren;
  className?: string;
  size?: DialogSize;
  showCloseButton?: boolean;
  closeOnOutsideClick?: boolean;
  closeOnEsc?: boolean;
}

interface DialogHeaderProps {
  children: ComponentChildren;
  className?: string;
}

interface DialogBodyProps {
  children: ComponentChildren;
  className?: string;
}

interface DialogFooterProps {
  children: ComponentChildren;
  className?: string;
}

const sizeClasses = {
  xs: "max-w-xs",
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  full: "max-w-[95vw]",
};

export function Dialog({
  open,
  onClose,
  children,
  className,
  size = "md",
  showCloseButton = true,
  closeOnOutsideClick = true,
  closeOnEsc = true,
}: DialogProps) {
  // Handle ESC key
  useEffect(() => {
    if (!open || !closeOnEsc || !onClose) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose?.();
      }
    };

    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, closeOnEsc, onClose]);

  if (!open) return null;

  const handleBackdropClick = () => {
    if (closeOnOutsideClick && onClose) {
      onClose();
    }
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-500/50"
      onClick={handleBackdropClick}
    >
      <div
        class={cn(
          "relative mx-auto max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-neutral-200 bg-white shadow-xl",
          sizeClasses[size],
          className
        )}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {showCloseButton && onClose && (
          <button
            type="button"
            onClick={onClose}
            class={cn(
              "absolute top-4 right-4 z-10 rounded-full p-1 text-neutral-400 transition-colors",
              "hover:bg-neutral-100 hover:text-neutral-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none"
            )}
            aria-label="Close dialog"
          >
            <X className="size-4" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ children, className }: DialogHeaderProps) {
  return <div class={cn("px-6 py-4", className)}>{children}</div>;
}

export function DialogTitle({
  children,
  className,
}: {
  children: ComponentChildren;
  className?: string;
}) {
  return (
    <h2 class={cn("text-base font-semibold text-neutral-900", className)}>
      {children}
    </h2>
  );
}

export function DialogDescription({
  children,
  className,
}: {
  children: ComponentChildren;
  className?: string;
}) {
  return (
    <p class={cn("mt-1 text-sm text-neutral-600", className)}>{children}</p>
  );
}

export function DialogContent({ children, className }: DialogBodyProps) {
  return (
    <div class={cn("flex flex-col gap-4 px-6 py-4", className)}>{children}</div>
  );
}

export function DialogFooter({ children, className }: DialogFooterProps) {
  return (
    <div class={cn("flex items-center justify-end gap-2 px-6 py-4", className)}>
      {children}
    </div>
  );
}
