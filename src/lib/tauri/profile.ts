import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";

import type {
  ConnectionCreateInput,
  ConnectionProfile,
  ProfileConnectInput,
  ProfileConnectResult,
  ProfileSaveAndConnectInput,
  ProfileSaveAndConnectResult,
  SaveAndConnectAction,
  SaveAndConnectInput,
  SecretRef,
} from "./types";
import { secretsDelete, secretsGet, secretsSet } from "./secrets";
import { CMD } from "./commands";

/* ============================================================================
 * Profiles (disk)
 * ============================================================================
 */

export async function profileList(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>(CMD.profileList);
}

export async function profileConnect(
  profileId: string
): Promise<ProfileConnectResult> {
  const payload: ProfileConnectInput = { profile_id: profileId };
  return invoke<ProfileConnectResult>(CMD.profileConnect, { payload });
}

export async function profileCreate(
  input: SaveAndConnectInput
): Promise<ConnectionProfile> {
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
 * - Supports BOTH:
 *   (A) no password (empty) + no keychain
 *   (B) save to keychain (storeKeychain=true)
 * - NEVER sends plaintext password to Rust when storeKeychain=true
 * - When storeKeychain=false, it DOES send inline password (can be empty) so Rust can connect now
 * ============================================================================
 */

export async function profileSaveAndConnect(
  input: SaveAndConnectInput & SaveAndConnectAction
): Promise<ProfileSaveAndConnectResult> {
  const mode = input.mode;
  const profileId = mode === "create" ? uuidv4() : input.profileId;

  const persistSecrets = !!input.storeKeychain;
  const engine = String(input.engine || "");
  const keychainKey = keychainKeyForProfile(profileId, engine);

  let oldSecret: string | null = null;
  let didTouchKeychain = false;

  try {
    if (persistSecrets) {
      // Update: backup old secret for rollback
      if (mode === "update") {
        oldSecret = await secretsGet(keychainKey).catch(() => null);
      }

      // Allow "no password" globally:
      // - if password empty => we do NOT write keychain (avoid storing empty)
      // - payload will still point to keychain key; backend should treat missing key as "no password"
      const pw = (input.password ?? "").toString();

      if (pw.trim().length > 0) {
        await secretsSet(keychainKey, pw);
        didTouchKeychain = true;
      }
    }

    // Build payload sent to backend (engine-aware + ssh included)
    // Rule:
    // - persistSecrets=true => password ref MUST be Keychain (never plaintext)
    // - persistSecrets=false => password ref MUST be Inline (plaintext allowed, can be empty)
    const payload = preparePayloadWithSecret(input, {
      profileId,
      persistSecrets,
      keychainKey,
      passwordPlain: (input.password ?? "").toString(),
    });

    const cmdPayload: ProfileSaveAndConnectInput =
      mode === "create"
        ? {
            mode: "create",
            profile_id: profileId,
            persist_secrets: persistSecrets,
            input: payload,
          }
        : {
            mode: "update",
            profile_id: profileId,
            persist_secrets: persistSecrets,
            input: payload,
          };

    return await invoke<ProfileSaveAndConnectResult>(
      CMD.profileSaveAndConnect,
      {
        payload: cmdPayload,
      }
    );
  } catch (err) {
    // Rollback keychain only if we actually wrote anything
    if (persistSecrets && didTouchKeychain) {
      if (mode === "create") {
        await secretsDelete(keychainKey).catch(() => {});
      } else {
        if (oldSecret != null && oldSecret.trim().length > 0) {
          await secretsSet(keychainKey, oldSecret).catch(() => {});
        } else {
          await secretsDelete(keychainKey).catch(() => {});
        }
      }
    }
    throw err;
  }
}

/* ============================================================================
 * Internal helpers
 * ============================================================================
 */

function keychainKeyForProfile(profileId: string, engine: string) {
  // MUST match backend: profile:{profile_id}:{engine}:password
  // engine should be: postgres | mysql | redis
  return `profile:${profileId}:${engine}:password`;
}

function secretInline(value: string): SecretRef {
  return { kind: "inline", value };
}

function secretKeychain(key: string): SecretRef {
  return { kind: "keychain", value: key };
}

/**
 * sanitizePayload:
 * - Strip FE-only fields (storeKeychain/password/...)
 * - Keep ALL engine config + ssh as-is
 * - Do NOT try to rewrite password here (that's preparePayloadWithSecret's job)
 */
function sanitizePayload(input: SaveAndConnectInput): ConnectionCreateInput {
  const {
    storeKeychain,
    password,
    // optional legacy field if you still have it somewhere
    keychainKey,
    ...payload
  } = input as any;

  return payload as ConnectionCreateInput;
}

function preparePayloadWithSecret(
  input: SaveAndConnectInput,
  opts: {
    profileId: string;
    persistSecrets: boolean;
    keychainKey: string;
    passwordPlain: string;
  }
): ConnectionCreateInput {
  const payload = sanitizePayload(input);
  const engine = String(payload.engine || "");

  // Always enforce correct secret ref shape per mode
  const ref = opts.persistSecrets
    ? secretKeychain(opts.keychainKey)
    : secretInline(opts.passwordPlain);

  if (engine === "postgres") {
    const pg = (payload.postgres ??= {} as any);
    pg.password = ref;
  }

  if (engine === "mysql") {
    const my = (payload.mysql ??= {} as any);
    my.password = ref;
  }

  if (engine === "redis") {
    const p: any = payload as any;
    const r = (p.redis ??= {} as any);
    // If your Rust Redis input uses SecretRef (not Option), assign directly
    // If Rust uses Option<SecretRef>, change to: r.password = opts.persistSecrets ? ref : (opts.passwordPlain ? ref : null)
    r.password = ref;
  }

  return payload;
}
