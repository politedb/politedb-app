import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
};

type ShowToastOptions = {
  tone?: ToastTone;
  durationMs?: number;
};

type ToastState = {
  toasts: ToastItem[];
  showToast: (message: string, opts?: ShowToastOptions) => string;
  dismissToast: (id: string) => void;
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
      toasts: [...state.toasts, { id, message, tone }],
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
