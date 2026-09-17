import { useToastStore, type ToastTone } from "src/stores/toast";
import { CheckMarkIcon, XIcon } from "src/components/icons";
import { cn } from "src/utils/cn";

const toneClass: Record<ToastTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  error: "border-red-200 bg-red-50 text-red-900",
  info: "border-neutral-200 bg-white text-neutral-900",
};

const iconWrapClass: Record<ToastTone, string> = {
  success: "bg-emerald-600 text-white",
  error: "bg-red-600 text-white",
  info: "bg-neutral-700 text-white",
};

export function Toast() {
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (!toasts.length) return null;

  return (
    <div
      class="pointer-events-none fixed top-18 right-3 z-100 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          class={cn(
            "animate-slide-in-left pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-md",
            toneClass[toast.tone]
          )}
          role="status"
        >
          <span
            class={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
              iconWrapClass[toast.tone]
            )}
          >
            {toast.tone === "success" ? (
              <CheckMarkIcon className="size-3" />
            ) : toast.tone === "error" ? (
              <XIcon className="size-3" />
            ) : (
              <span class="text-[10px] leading-none font-bold">i</span>
            )}
          </span>
          <p class="min-w-0 flex-1 text-sm leading-5 wrap-break-word">
            {toast.message}
          </p>
          <button
            type="button"
            class="shrink-0 rounded p-0.5 text-current opacity-60 hover:opacity-100"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
