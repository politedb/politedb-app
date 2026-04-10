import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export type LicenseStatusKind = "inactive" | "active" | "invalid" | "error";

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
  message?: string | null;
};

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
    api_base: args.apiBase,
    product: args.product,
    license_key: args.licenseKey,
  });
}

export async function licenseRefresh(args: {
  apiBase: string;
  product: string;
}) {
  return invoke<LicenseState>(CMD.licenseRefresh, {
    api_base: args.apiBase,
    product: args.product,
  });
}

export async function licenseDeactivate(args: {
  apiBase: string;
  product: string;
}) {
  return invoke<LicenseState>(CMD.licenseDeactivate, {
    api_base: args.apiBase,
    product: args.product,
  });
}

export async function licenseOpenExternalUrl(url: string) {
  return invoke<void>(CMD.licenseOpenExternalUrl, { url });
}
