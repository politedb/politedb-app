import { create } from "zustand";
import type { LicenseState } from "src/lib/tauri";
import {
  licenseActivate,
  licenseDeactivate,
  licenseErrorState,
  licenseStateClear,
  licenseStateLoad,
  licenseRefresh,
  licenseTrialSync,
} from "src/lib/tauri";
import type { LicenseOpError } from "src/lib/tauri";
import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import { hasProAccess } from "src/lib/license/proAccess";

/** Read on use, not at import, so the value can change in tests. */
function licenseApiBase() {
  return (import.meta.env.VITE_POLITEDB_API_BASE ?? "").trim();
}
const LICENSE_PRODUCT = (
  import.meta.env.VITE_LICENSE_PRODUCT ?? "politedb"
).trim();

/** Longest single wait before re-reading at `pro_access_until` (timers drift on sleep). */
const MAX_EXPIRY_WAIT_MS = 24 * 60 * 60 * 1000;
/** Minimum gap between re-reads triggered by focus, visibility or network changes. */
const LIFECYCLE_RELOAD_GAP_MS = 2_000;

/** Trial sync cadence (plan pro-gating V4). */
const TRIAL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TRIAL_SYNC_FOCUS_GAP_MS = 10 * 60 * 1000;
const TRIAL_SYNC_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const TRIAL_SYNC_MIN_RETRY_AFTER_MS = 60_000;

/**
 * State of the license-server trial sync, shown in License settings:
 * `verified` after a successful sync, `pending` before the first answer, `unavailable`
 * while the server cannot be reached or refused the request.
 */
export type TrialSyncStatus = "idle" | "pending" | "verified" | "unavailable";

export type TrialSyncReason = "load" | "focus" | "online" | "timer";

type LicenseStoreState = {
  state: LicenseState | null;
  /** `snapshot_seq` of the published state; older snapshots are ignored. */
  publishedSeq: number;
  trialSync: { status: TrialSyncStatus; lastOkAt: number | null };
  busy: boolean;
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  /** Shows `next` unless a newer snapshot is already shown. */
  publishSnapshot: (next: LicenseState | null | undefined) => boolean;
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
  if (!licenseApiBase()) return null;
  return licenseRefresh({
    apiBase: licenseApiBase(),
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
  const onChange = (event: Event) => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    requestTrialSync(event.type === "online" ? "online" : "focus");
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
    trialSync: { status: "idle", lastOkAt: null },
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
        requestTrialSync("load");

        if (hasActivationData(state) && licenseApiBase()) {
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
          apiBase: licenseApiBase(),
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
          apiBase: licenseApiBase(),
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
                apiBase: licenseApiBase(),
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
    publishSnapshot: publish,
  };
});

/** Pro access right now, read from the store at call time (for action guards). */
export function hasProAccessNow() {
  return hasProAccess(useLicenseStore.getState().state);
}

/**
 * Trial sync scheduler: one per app session, independent of license re-reads. A single
 * request runs at a time; success waits 6 hours, failures back off, `Retry-After` is
 * honoured, and a 400 stops syncing until the app restarts. A failure never removes the
 * trial window already stored on the device.
 */
const trialSync = {
  inFlight: false,
  nextAttemptAt: 0,
  lastAttemptAt: 0,
  failures: 0,
  lastFailureWasNetwork: false,
  suppressed: false,
  timer: null as ReturnType<typeof setTimeout> | null,
};

function setTrialSyncStatus(status: TrialSyncStatus, lastOkAt?: number | null) {
  const current = useLicenseStore.getState().trialSync;
  useLicenseStore.setState({
    trialSync: {
      status,
      lastOkAt: lastOkAt === undefined ? current.lastOkAt : lastOkAt,
    },
  });
}

function scheduleTrialSyncWake() {
  if (trialSync.timer) clearTimeout(trialSync.timer);
  trialSync.timer = null;
  if (trialSync.suppressed) return;
  // Long waits (a large Retry-After) are split: timers overflow past ~24.8 days, and an
  // early wake only re-arms until the deadline.
  const delay = Math.min(
    Math.max(trialSync.nextAttemptAt - Date.now(), 0),
    MAX_EXPIRY_WAIT_MS
  );
  trialSync.timer = setTimeout(() => {
    trialSync.timer = null;
    if (Date.now() < trialSync.nextAttemptAt) {
      scheduleTrialSyncWake();
      return;
    }
    requestTrialSync("timer");
  }, delay);
}

function failureDelay(error: LicenseOpError | null) {
  const backoff =
    TRIAL_SYNC_BACKOFF_MS[
      Math.min(trialSync.failures, TRIAL_SYNC_BACKOFF_MS.length - 1)
    ];
  if (error?.kind === "http" && error.status === 429) {
    return Math.max(
      error.retryAfterMs ?? backoff,
      TRIAL_SYNC_MIN_RETRY_AFTER_MS
    );
  }
  return backoff;
}

async function runTrialSync() {
  trialSync.inFlight = true;
  trialSync.lastAttemptAt = Date.now();
  if (useLicenseStore.getState().trialSync.status !== "verified") {
    setTrialSyncStatus("pending");
  }
  try {
    const next = await licenseTrialSync({
      apiBase: licenseApiBase(),
      product: LICENSE_PRODUCT,
    });
    useLicenseStore.getState().publishSnapshot(next);
    trialSync.failures = 0;
    trialSync.lastFailureWasNetwork = false;
    trialSync.nextAttemptAt = Date.now() + TRIAL_SYNC_INTERVAL_MS;
    setTrialSyncStatus("verified", Date.now());
  } catch (raw) {
    useLicenseStore.getState().publishSnapshot(licenseErrorState(raw));
    const error =
      raw && typeof raw === "object" && "kind" in raw
        ? (raw as LicenseOpError)
        : null;
    if (error?.kind === "http" && error.status === 400) {
      trialSync.suppressed = true;
    } else {
      trialSync.nextAttemptAt = Date.now() + failureDelay(error);
      trialSync.failures += 1;
    }
    trialSync.lastFailureWasNetwork =
      !error ||
      error.kind === "network" ||
      error.kind === "timeout" ||
      (error.kind === "http" && error.status === 404);
    setTrialSyncStatus("unavailable");
  } finally {
    trialSync.inFlight = false;
    scheduleTrialSyncWake();
  }
}

/** Asks for a trial sync; ignored while one runs, during a backoff, or when not needed. */
export function requestTrialSync(reason: TrialSyncReason) {
  if (!DISTRIBUTION_FEATURES.serverTrial || !licenseApiBase()) return;
  if (trialSync.suppressed || trialSync.inFlight) return;
  const now = Date.now();
  if (
    reason === "focus" &&
    now - trialSync.lastAttemptAt < TRIAL_SYNC_FOCUS_GAP_MS
  ) {
    return;
  }
  const retryOnline = reason === "online" && trialSync.lastFailureWasNetwork;
  if (now < trialSync.nextAttemptAt && !retryOnline) return;
  void runTrialSync();
}

/** Tests only: forgets the scheduler state. */
export function resetTrialSyncForTests() {
  if (trialSync.timer) clearTimeout(trialSync.timer);
  Object.assign(trialSync, {
    inFlight: false,
    nextAttemptAt: 0,
    lastAttemptAt: 0,
    failures: 0,
    lastFailureWasNetwork: false,
    suppressed: false,
    timer: null,
  });
}
