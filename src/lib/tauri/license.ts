import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export type LicenseStatusKind =
  | "inactive"
  | "active"
  | "expired"
  | "invalid"
  | "error";

export type LicenseDeviceInfo = {
  device_id: string;
  device_name: string;
  platform: string;
  arch: string;
};

export type LicenseState = {
  version: number;
  status: LicenseStatusKind | string;
  device_id: string;
  device_name: string;
  platform: string;
  arch: string;
  license_key?: string | null;
  activation_token?: string | null;
  license_id?: string | null;
  plan_name?: string | null;
  customer_email?: string | null;
  instance_name?: string | null;
  expires_at?: string | null;
  activated_at?: number | null;
  last_validated_at?: number | null;
  seats_allowed?: number | null;
  devices_used?: number | null;
  trial_started_at?: number | null;
  trial_expires_at?: number | null;
  message?: string | null;
  /** Feature tier from the license API ("pro" | "free"); absent on older servers. */
  plan?: string | null;
  /** Pro features unlocked (license or trial). Computed by the Rust side on every read. */
  pro_access?: boolean;
  /** When the current Pro access ends (epoch ms); null when unlimited or locked. */
  pro_access_until?: number | null;
  /** An active license on a paid plan, trials excluded. Computed by the Rust side. */
  paid_license?: boolean;
  /** Original start of a trial kept by an older build (migration only). */
  legacy_trial_started_at?: number | null;
  legacy_retired?: boolean;
  /** The trial window recorded by the license server; the only trial that unlocks Pro. */
  trial?: ServerTrial | null;
  /** Incremented by every write of the license file. */
  revision?: number;
  /** Order of this snapshot in the app session; only newer snapshots are shown. */
  snapshot_seq?: number;
};

/** A trial window from the license server (epoch ms) and when it was fetched. */
export type ServerTrial = {
  started_at: number;
  expires_at: number;
  synced_at: number;
};

export type LicenseErrorKind =
  | "config"
  | "timeout"
  | "network"
  | "http"
  | "malformed"
  | "storage";

/** A failed license command. `state` is the current snapshot, still worth showing. */
export type LicenseOpError = {
  kind: LicenseErrorKind;
  status?: number;
  retryAfterMs?: number;
  message: string;
  state?: LicenseState;
};

/** The snapshot attached to a failed license command, if any. */
export function licenseErrorState(error: unknown): LicenseState | null {
  if (!error || typeof error !== "object" || !("state" in error)) return null;
  const state = (error as { state?: unknown }).state;
  return state && typeof state === "object" ? (state as LicenseState) : null;
}

/** UI label from backend `plan_name` (e.g. "ultimate" → "Ultimate plan"). */
export function formatLicensePlanLabel(planName?: string | null): string {
  const raw = String(planName ?? "").trim();
  if (!raw) return "Free plan";

  const withoutSuffix = raw.replace(/\s*plan$/i, "").trim();
  if (!withoutSuffix) return "Free plan";

  const label =
    withoutSuffix.charAt(0).toUpperCase() +
    withoutSuffix.slice(1).toLowerCase();
  return `${label} plan`;
}

export async function licenseDeviceInfo() {
  return invoke<LicenseDeviceInfo>(CMD.licenseDeviceInfo);
}

export async function licenseStateLoad() {
  return invoke<LicenseState>(CMD.licenseStateLoad);
}

export async function licenseStateSave(state: LicenseState) {
  return invoke<LicenseState>(CMD.licenseStateSave, { state });
}

export async function licenseStateClear() {
  return invoke<LicenseState>(CMD.licenseStateClear);
}

export async function licenseActivate(args: {
  apiBase: string;
  product: string;
  licenseKey: string;
}) {
  return invoke<LicenseState>(CMD.licenseActivate, {
    apiBase: args.apiBase,
    product: args.product,
    licenseKey: args.licenseKey,
  });
}

export async function licenseRefresh(args: {
  apiBase: string;
  product: string;
}) {
  return invoke<LicenseState>(CMD.licenseRefresh, {
    apiBase: args.apiBase,
    product: args.product,
  });
}

/** Fetches this device's trial window from the license server and stores it. */
export async function licenseTrialSync(args: {
  apiBase: string;
  product: string;
}) {
  return invoke<LicenseState>(CMD.licenseTrialSync, {
    apiBase: args.apiBase,
    product: args.product,
  });
}

export async function licenseDeactivate(args: {
  apiBase: string;
  product: string;
}) {
  return invoke<LicenseState>(CMD.licenseDeactivate, {
    apiBase: args.apiBase,
    product: args.product,
  });
}

export async function licenseOpenExternalUrl(url: string) {
  return invoke<void>(CMD.licenseOpenExternalUrl, { url });
}

/** Backend error code when the build flavor forbids a destination (e.g. purchase links on the App Store). */
export const FEATURE_UNAVAILABLE_IN_DISTRIBUTION =
  "FEATURE_UNAVAILABLE_IN_DISTRIBUTION";

/** Navigates the webview itself; mail clients pick up `mailto:` links this way. */
export function navigateToUrl(url: string) {
  window.location.href = url;
}

function openInNewWindow(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Opens `url` with the system handler through the backend URL policy. Falls back to the
 * webview only when the opener itself fails, never when the policy rejected the URL.
 */
export async function openExternalUrl(
  url: string,
  fallback: (url: string) => void = openInNewWindow
) {
  try {
    await licenseOpenExternalUrl(url);
  } catch (error) {
    if (String(error).includes(FEATURE_UNAVAILABLE_IN_DISTRIBUTION)) return;
    fallback(url);
  }
}
