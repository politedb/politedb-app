import { create } from "zustand";
import type { LicenseState } from "src/lib/tauri";
import {
  licenseActivate,
  licenseDeactivate,
  licenseErrorState,
  licenseStateClear,
  licenseStateLoad,
  licenseRefresh,
} from "src/lib/tauri";
import { hasProAccess } from "src/lib/license/proAccess";

const POLITEDB_API_BASE = (import.meta.env.VITE_POLITEDB_API_BASE ?? "").trim();
const LICENSE_PRODUCT = (
  import.meta.env.VITE_LICENSE_PRODUCT ?? "politedb"
).trim();

/** Longest single wait before re-reading at `pro_access_until` (timers drift on sleep). */
const MAX_EXPIRY_WAIT_MS = 24 * 60 * 60 * 1000;
/** Minimum gap between re-reads triggered by focus, visibility or network changes. */
const LIFECYCLE_RELOAD_GAP_MS = 2_000;

type LicenseStoreState = {
  state: LicenseState | null;
  /** `snapshot_seq` of the published state; older snapshots are ignored. */
  publishedSeq: number;
  busy: boolean;
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  /** Re-reads the license file (no network) so time-based changes such as an expiry show. */
  reload: () => Promise<void>;
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

async function refreshLicenseSilently() {
  if (!POLITEDB_API_BASE) return null;
  return licenseRefresh({
    apiBase: POLITEDB_API_BASE,
    product: LICENSE_PRODUCT,
  });
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Re-reads the license when the current Pro access ends, so gates lock without a restart. */
function scheduleExpiryReload(state: LicenseState | null) {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const until = state?.pro_access_until;
  if (until == null) return;
  const delay = Math.min(
    Math.max(until - Date.now(), 0) + 50,
    MAX_EXPIRY_WAIT_MS
  );
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    void useLicenseStore.getState().reload();
  }, delay);
}

let lifecycleInstalled = false;
let lastLifecycleReload = 0;

/** Re-reads on focus, return from background and reconnect (timers stop while asleep). */
function installLifecycleReload() {
  if (lifecycleInstalled || typeof window === "undefined") return;
  lifecycleInstalled = true;
  const onChange = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastLifecycleReload < LIFECYCLE_RELOAD_GAP_MS) return;
    lastLifecycleReload = now;
    void useLicenseStore.getState().reload();
  };
  window.addEventListener("focus", onChange);
  window.addEventListener("online", onChange);
  document.addEventListener("visibilitychange", onChange);
}

export const useLicenseStore = create<LicenseStoreState>((set, get) => {
  /** Shows `next` unless a newer snapshot is already shown. */
  const publish = (next: LicenseState | null | undefined) => {
    if (!next) return false;
    const seq = next.snapshot_seq ?? 0;
    if (seq <= get().publishedSeq) return false;
    set({ state: next, publishedSeq: seq, loaded: true });
    scheduleExpiryReload(next);
    return true;
  };

  /** Publishes the snapshot a failed command carries and returns its message. */
  const publishError = (error: unknown) => {
    publish(licenseErrorState(error));
    return toErrorMessage(error);
  };

  return {
    state: null,
    publishedSeq: 0,
    busy: false,
    error: null,
    loaded: false,

    load: async () => {
      if (get().busy) return;
      installLifecycleReload();
      set({ busy: true, error: null });
      try {
        const state = await licenseStateLoad();
        publish(state);
        set({ busy: false, loaded: true });

        if (hasActivationData(state) && POLITEDB_API_BASE) {
          void refreshLicenseSilently()
            .then((next) => publish(next))
            .catch((error) => {
              publishError(error);
            });
        }
      } catch (error) {
        set({ busy: false, error: publishError(error), loaded: true });
      }
    },

    reload: async () => {
      try {
        publish(await licenseStateLoad());
      } catch (error) {
        publishError(error);
      }
    },

    activate: async (licenseKey) => {
      set({ busy: true, error: null });
      try {
        const next = await licenseActivate({
          apiBase: POLITEDB_API_BASE,
          product: LICENSE_PRODUCT,
          licenseKey,
        });
        publish(next);
        set({ busy: false });
        return next;
      } catch (error) {
        const message = publishError(error);
        set({ busy: false, error: message });
        throw new Error(message);
      }
    },

    refresh: async () => {
      set({ busy: true, error: null });
      try {
        const next = await licenseRefresh({
          apiBase: POLITEDB_API_BASE,
          product: LICENSE_PRODUCT,
        });
        publish(next);
        set({ busy: false });
        return next;
      } catch (error) {
        const message = publishError(error);
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
                apiBase: POLITEDB_API_BASE,
                product: LICENSE_PRODUCT,
              })
            : await licenseStateClear();
        publish(cleared);
        set({ busy: false });
      } catch (error) {
        const message = publishError(error);
        set({ busy: false, error: message });
        throw new Error(message);
      }
    },

    clearError: () => set({ error: null }),
  };
});

/** Pro access right now, read from the store at call time (for action guards). */
export function hasProAccessNow() {
  return hasProAccess(useLicenseStore.getState().state);
}
