import { create } from "zustand";
import type { LicenseState } from "src/lib/tauri";
import {
  licenseActivate,
  licenseDeactivate,
  licenseStateClear,
  licenseStateLoad,
  licenseRefresh,
} from "src/lib/tauri";

const LICENSE_API_BASE = (import.meta.env.VITE_LICENSE_API_BASE ?? "").trim();
const LICENSE_PRODUCT = (
  import.meta.env.VITE_LICENSE_PRODUCT ?? "politedb"
).trim();
const LICENSE_VALIDATION_GRACE_MS = 60 * 60 * 1000;

type LicenseStoreState = {
  state: LicenseState | null;
  busy: boolean;
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  activate: (licenseKey: string) => Promise<LicenseState>;
  refresh: () => Promise<LicenseState>;
  deactivate: () => Promise<void>;
  clearError: () => void;
};

function toErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "Unknown error");
  }
  return String(error ?? "Unknown error");
}

function hasActivationData(state?: LicenseState | null) {
  return Boolean(state?.license_key || state?.activation_token);
}

function isActiveLicenseValidationStale(state?: LicenseState | null) {
  if (!state) return false;
  if (String(state.status ?? "").toLowerCase() !== "active") return false;
  if (!hasActivationData(state)) return false;
  const lastValidatedAt = Number(state.last_validated_at ?? 0);
  if (!Number.isFinite(lastValidatedAt) || lastValidatedAt <= 0) return true;
  return Date.now() - lastValidatedAt > LICENSE_VALIDATION_GRACE_MS;
}

async function refreshLicenseSilently() {
  if (!LICENSE_API_BASE) return null;
  return licenseRefresh({
    apiBase: LICENSE_API_BASE,
    product: LICENSE_PRODUCT,
  });
}

export const useLicenseStore = create<LicenseStoreState>((set, get) => ({
  state: null,
  busy: false,
  error: null,
  loaded: false,

  load: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const state = await licenseStateLoad();
      set({ state, busy: false, loaded: true });

      if (hasActivationData(state) && LICENSE_API_BASE) {
        void refreshLicenseSilently()
          .then((next) => {
            if (!next) return;
            set({ state: next, loaded: true });
          })
          .catch(() => {
            const current = get().state;
            if (!current || !isActiveLicenseValidationStale(current)) return;
            set({
              state: {
                ...current,
                status: "unverified",
                message:
                  current?.message ||
                  "License validation expired. Please reconnect and refresh your license.",
              },
              loaded: true,
            });
          });
      }
    } catch (error) {
      set({ busy: false, error: toErrorMessage(error), loaded: true });
    }
  },

  activate: async (licenseKey) => {
    set({ busy: true, error: null });
    try {
      const next = await licenseActivate({
        apiBase: LICENSE_API_BASE,
        product: LICENSE_PRODUCT,
        licenseKey,
      });
      set({ state: next, busy: false, loaded: true });
      return next;
    } catch (error) {
      const message = toErrorMessage(error);
      set({ busy: false, error: message });
      throw new Error(message);
    }
  },

  refresh: async () => {
    set({ busy: true, error: null });
    try {
      const next = await licenseRefresh({
        apiBase: LICENSE_API_BASE,
        product: LICENSE_PRODUCT,
      });
      set({ state: next, busy: false, loaded: true });
      return next;
    } catch (error) {
      const message = toErrorMessage(error);
      set({ busy: false, error: message });
      throw new Error(message);
    }
  },

  deactivate: async () => {
    set({ busy: true, error: null });
    try {
      const current = get().state ?? (await licenseStateLoad());
      const cleared =
        current.license_key || current.activation_token
          ? await licenseDeactivate({
              apiBase: LICENSE_API_BASE,
              product: LICENSE_PRODUCT,
            })
          : await licenseStateClear();
      set({ state: cleared, busy: false, loaded: true });
    } catch (error) {
      const message = toErrorMessage(error);
      set({ busy: false, error: message });
      throw new Error(message);
    }
  },

  clearError: () => set({ error: null }),
}));
