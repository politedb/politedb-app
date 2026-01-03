import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  ProfileSaveAndConnectInput,
  ProfileSaveAndConnectResult,
  SaveAndConnectAction,
  SaveAndConnectInput,
} from "./types";
import { secretsDelete, secretsSet } from "./secrets";
import { CMD } from "./commands";

/* ============================================================================
 * Profiles (disk)
 * ============================================================================
 */

export async function profileList(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>(CMD.profileList);
}

export async function profileCreate(
  input: SaveAndConnectInput
): Promise<ConnectionProfile> {
  // NOTE: this is disk-only. Prefer profileSaveAndConnect for user flow.
  const payload = sanitizePayload(input);
  return invoke<ConnectionProfile>(CMD.profileCreate, { input: payload });
}

export async function profileUpdate(
  profileId: string,
  input: SaveAndConnectInput
): Promise<ConnectionProfile> {
  const payload = sanitizePayload(input);
  return invoke<ConnectionProfile>(CMD.profileUpdate, {
    profile_id: profileId,
    input: payload,
  });
}

export async function profileRemove(profileId: string): Promise<void> {
  await invoke(CMD.profileRemove, { profile_id: profileId });
}

/* ============================================================================
 * Save & Connect (primary flow)
 * ============================================================================
 */

export async function profileSaveAndConnect(
  input: SaveAndConnectInput & SaveAndConnectAction
): Promise<ProfileSaveAndConnectResult> {
  const { storeKeychain, password, keychainKey, mode } = input;

  // 1) store secret first
  if (storeKeychain && password) {
    await secretsSet(keychainKey, password);
  }

  // 2) prepare payload: NEVER send plaintext password
  const payload = sanitizePayload(input);

  // 3) build rust enum payload
  const cmdPayload: ProfileSaveAndConnectInput =
    mode === "create"
      ? { mode: "create", input: payload }
      : { mode: "update", profile_id: input.profileId, input: payload };

  try {
    return await invoke<ProfileSaveAndConnectResult>(
      CMD.profileSaveAndConnect,
      {
        payload: cmdPayload,
      }
    );
  } catch (err) {
    // rollback secret if needed (optional)
    if (storeKeychain) {
      await secretsDelete(keychainKey).catch(() => {});
    }
    throw err;
  }
}

/* ============================================================================
 * Internal helpers
 * ============================================================================
 */

/**
 * Remove FE-only fields & ensure password never goes to backend in plaintext.
 * - If password.kind === "inline": wipe value, backend should treat as empty string
 * - If password.kind === "keychain": keep keychain key in .value
 */
function sanitizePayload(input: SaveAndConnectInput): any {
  const { storeKeychain, password, keychainKey, ...payload } = input as any;

  // If user selected keychain, ensure payload is keychain ref
  if (storeKeychain) {
    payload.postgres.password = { kind: "keychain", value: keychainKey };
  } else {
    // inline mode: the caller may set inline password ref, but plaintext must not be sent
    if (payload?.postgres?.password?.kind === "inline") {
      payload.postgres.password.value = "";
    }
  }

  return payload;
}
