import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";

/** A button on the toast; the toast stays until its action settles. */
export type ToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
};

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
};

type ShowToastOptions = {
  tone?: ToastTone;
  durationMs?: number;
  action?: ToastAction;
};

type ToastState = {
  toasts: ToastItem[];
  showToast: (message: string, opts?: ShowToastOptions) => string;
  dismissToast: (id: string) => void;
  /** Stop a toast's timer (its action is running). */
  holdToast: (id: string) => void;
};

const DEFAULT_DURATION_MS = 3_500;
const timers = new Map<string, number>();

function clearTimer(id: string) {
  const timerId = timers.get(id);
  if (timerId != null) {
    window.clearTimeout(timerId);
    timers.delete(id);
  }
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  showToast: (message, opts) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tone = opts?.tone ?? "info";
    const durationMs = opts?.durationMs ?? DEFAULT_DURATION_MS;

    set((state) => ({
      toasts: [
        ...state.toasts,
        opts?.action
          ? { id, message, tone, action: opts.action }
          : { id, message, tone },
      ],
    }));

    if (durationMs > 0 && typeof window !== "undefined") {
      clearTimer(id);
      const timerId = window.setTimeout(() => {
        get().dismissToast(id);
      }, durationMs);
      timers.set(id, timerId);
    }

    return id;
  },
  holdToast: (id) => clearTimer(id),
  dismissToast: (id) => {
    clearTimer(id);
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));

export function showToast(message: string, opts?: ShowToastOptions) {
  return useToastStore.getState().showToast(message, opts);
}
