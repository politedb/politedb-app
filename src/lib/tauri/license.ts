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
};

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
