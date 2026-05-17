import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";

import type {
  ConnectionCreateInput,
  ConnectionProfile,
  SecretRef,
  ConnectionTestSecrets,
  ProfileImportResult,
  ExternalImportResult,
  ProfileConnectInput,
  ProfileConnectResult,
  ProfileConnectTestInput,
  ProfileSaveAndConnectInput,
  ProfileSaveAndConnectResult,
  ProfileSaveInput,
  SaveAndConnectInput,
} from "./types";
import { CMD } from "./commands";
import { secretsDelete, secretsGet, secretsSet } from "./secrets";
import type { DatabaseEngine } from "src/types";

/* ============================================================================
 * Local types
 * ============================================================================
 */

type SaveMode = "create" | "update";
type SaveAction = { mode: "create" } | { mode: "update"; profileId: string };

type SaveResultMap = {
  save: ConnectionProfile;
  save_and_connect: ProfileSaveAndConnectResult;
};

type SaveKind = keyof SaveResultMap; // "save" | "save_and_connect"

type PersistPlan = {
  mode: SaveMode;
  profileId: string;
  persistSecrets: boolean;

  // DB secret key
  dbKey: string;

  // Optional SSH secret key (only used if ssh auth is password)
  sshKey?: string;

  // Plain secrets from UI (FE-only)
  dbPasswordPlain: string;
  sshPasswordPlain: string;
};

/* ============================================================================
 * Keychain key helpers
 * ============================================================================
 * You can change these formats anytime, as long as FE+Rust agree.
 */

function keychainKeyForProfileDb(profileId: string, engine: string) {
  return `politedb/profile/${profileId}/${engine}/db_password`;
}

function keychainKeyForProfileSsh(profileId: string) {
  return `politedb/profile/${profileId}/ssh_password`;
}

/* ============================================================================
 * SecretRef helpers
 * ============================================================================
 */

function secretRefForDb(
  persistSecrets: boolean,
  key: string,
  plain: string
): { kind: "keychain"; value: string } | { kind: "inline"; value: string } {
  return persistSecrets
    ? { kind: "keychain", value: key }
    : { kind: "inline", value: plain };
}

function shouldPersistSshPassword(input: SaveAndConnectInput) {
  const auth = input.ssh?.auth;
  return !!auth && auth.kind === "password";
}

function secretRefForSshPassword(
  persistSecrets: boolean,
  key: string,
  plain: string
): { kind: "keychain"; value: string } | { kind: "inline"; value: string } {
  return persistSecrets
    ? { kind: "keychain", value: key }
    : { kind: "inline", value: plain };
}

/* ============================================================================
 * preparePayloadWithSecret
 * - Convert FE UI input (which may include plaintext) into Rust contract input
 * - Rule:
 *   - persistSecrets=true => NEVER embed plaintext; SecretRef must be Keychain
 *   - persistSecrets=false => SecretRef can be Inline (plaintext allowed)
 * ============================================================================
 */

export function preparePayloadWithSecret(
  input: SaveAndConnectInput,
  plan: Pick<
    PersistPlan,
    | "persistSecrets"
    | "profileId"
    | "dbKey"
    | "sshKey"
    | "dbPasswordPlain"
    | "sshPasswordPlain"
  >
): ConnectionCreateInput {
  const engine = String(input.engine || "") as DatabaseEngine;
  const label = String(input.label || "");
  const tags = input.tags;
  const indicator_color = input.indicator_color || "";

  const persistSecrets = plan.persistSecrets;

  // SSH: keep as-is, but normalize password ref if needed
  const ssh =
    input.ssh && input.ssh.enabled !== false
      ? (() => {
          const base = { ...input.ssh };
          if (base.auth?.kind === "password") {
            const sshKey =
              plan.sshKey || keychainKeyForProfileSsh(plan.profileId);
            const plain = (plan.sshPasswordPlain ?? "").toString();
            return {
              ...base,
              auth: {
                kind: "password" as const,
                password: secretRefForSshPassword(
                  persistSecrets,
                  sshKey,
                  plain
                ),
              },
            };
          }
          // private_key: passphrase secret (if you later want to persist it, add key + rollout)
          return base;
        })()
      : undefined;

  // Engine-specific: convert db password SecretRef
  if (engine === "postgres") {
    const pg = input.postgres;
    if (!pg) throw new Error("POSTGRES_CONFIG_MISSING");

    const dbRef = secretRefForDb(
      persistSecrets,
      plan.dbKey,
      plan.dbPasswordPlain
    );

    return {
      engine,
      label,
      tags,
      indicator_color,
      ssh,
      postgres: {
        ...pg,
        password: dbRef,
      },
    };
  }

  if (engine === "mysql" || engine === "mariadb") {
    const my = input.mysql;
    if (!my) throw new Error("MYSQL_CONFIG_MISSING");

    const dbRef = secretRefForDb(
      persistSecrets,
      plan.dbKey,
      plan.dbPasswordPlain
    );

    return {
      engine,
      label,
      tags,
      indicator_color,
      ssh,
      mysql: {
        ...my,
        password: dbRef,
      },
    };
  }

  if (engine === "mongo") {
    const mongo = input.mongo;
    if (!mongo) throw new Error("MONGO_CONFIG_MISSING");

    const dbRef = secretRefForDb(
      persistSecrets,
      plan.dbKey,
      plan.dbPasswordPlain
    );

    return {
      engine,
      label,
      tags,
      indicator_color,
      ssh,
      mongo: {
        ...mongo,
        password: dbRef,
      },
    };
  }

  if (engine === "sqlserver") {
    const sqlserver = input.sqlserver;
    if (!sqlserver) throw new Error("SQLSERVER_CONFIG_MISSING");

    const dbRef = secretRefForDb(
      persistSecrets,
      plan.dbKey,
      plan.dbPasswordPlain
    );

    return {
      engine,
      label,
      tags,
      indicator_color,
      ssh,
      sqlserver: {
        ...sqlserver,
        password: dbRef,
      },
    };
  }

  if (engine === "sqlite") {
    const sqlite = input.sqlite;
    if (!sqlite) throw new Error("SQLITE_CONFIG_MISSING");

    return {
      engine,
      label,
      tags,
      indicator_color,
      ssh,
      sqlite: {
        ...sqlite,
      },
    };
  }

  if (engine === "oracle") {
    const oracle = input.oracle;
    if (!oracle) throw new Error("ORACLE_CONFIG_MISSING");

    const dbRef = secretRefForDb(
      persistSecrets,
      plan.dbKey,
      plan.dbPasswordPlain
    );

    return {
      engine,
      label,
      tags,
      indicator_color,
      ssh,
      oracle: {
        ...oracle,
        password: dbRef,
      },
    };
  }

  if (engine === "redis") {
    const rd = input.redis;
    if (!rd) throw new Error("REDIS_CONFIG_MISSING");

    const dbRef = secretRefForDb(
      persistSecrets,
      plan.dbKey,
      plan.dbPasswordPlain
    );

    return {
      engine,
      label,
      tags,
      indicator_color,
      ssh,
      redis: {
        ...rd,
        password: dbRef,
      },
    };
  }

  // Unknown engine: keep payload but still respect secret rule if a known field exists
  // (You can tighten this later by throwing.)
  return {
    engine,
    tags,
    indicator_color,
    label,
    ssh,
    postgres: input.postgres,
    mysql: input.mysql,
    sqlserver: input.sqlserver,
    sqlite: input.sqlite,
    oracle: input.oracle,
    mongo: input.mongo,
    redis: input.redis,
  };
}

/* ============================================================================
 * Keychain rollback helper (supports DB + optional SSH password)
 * ============================================================================
 */

async function withKeychainRollback<T>(
  plan: PersistPlan,
  fn: () => Promise<T>
): Promise<T> {
  if (!plan.persistSecrets) return fn();

  const writeOps: Array<{
    key: string;
    value: string;
    old: string | null;
    touched: boolean;
  }> = [];

  async function stageKey(key: string, value: string) {
    const old =
      plan.mode === "update" ? await secretsGet(key).catch(() => null) : null;

    const trimmed = value.trim();
    const touched = trimmed.length > 0;

    writeOps.push({ key, value: trimmed, old, touched });

    if (touched) {
      await secretsSet(key, trimmed);
    }
  }

  try {
    // DB password: only store non-empty
    await stageKey(plan.dbKey, plan.dbPasswordPlain);

    // SSH password: only if ssh auth is password
    if (plan.sshKey) {
      await stageKey(plan.sshKey, plan.sshPasswordPlain);
    }

    return await fn();
  } catch (err) {
    // Rollback only keys we actually wrote (touched=true)
    for (const op of writeOps) {
      if (!op.touched) continue;

      if (plan.mode === "create") {
        await secretsDelete(op.key).catch(() => {});
        continue;
      }

      // update: restore old if exists else delete
      if (op.old != null && op.old.trim().length > 0) {
        await secretsSet(op.key, op.old).catch(() => {});
      } else {
        await secretsDelete(op.key).catch(() => {});
      }
    }

    throw err;
  }
}

/* ============================================================================
 * Build plan / payload / command payload
 * ============================================================================
 */

function buildSavePlan(input: SaveAndConnectInput & SaveAction): PersistPlan {
  const mode = input.mode;
  const profileId = mode === "create" ? uuidv4() : input.profileId;

  const persistSecrets = !!input.storeKeychain;
  const engine = String(input.engine || "");

  const dbKey = keychainKeyForProfileDb(profileId, engine);

  const sshKey = shouldPersistSshPassword(input)
    ? keychainKeyForProfileSsh(profileId)
    : undefined;

  return {
    mode,
    profileId,
    persistSecrets,

    dbKey,
    sshKey,

    dbPasswordPlain: (input.password ?? "").toString(),
    sshPasswordPlain: (input.ssh_password ?? "").toString(),
  };
}

function buildProfilePayload(
  input: SaveAndConnectInput,
  plan: PersistPlan
): ConnectionCreateInput {
  return preparePayloadWithSecret(input, {
    profileId: plan.profileId,
    persistSecrets: plan.persistSecrets,
    dbKey: plan.dbKey,
    sshKey: plan.sshKey,
    dbPasswordPlain: plan.dbPasswordPlain,
    sshPasswordPlain: plan.sshPasswordPlain,
  });
}

function buildCmdPayload(
  kind: SaveKind,
  plan: PersistPlan,
  payload: ConnectionCreateInput
): ProfileSaveInput | ProfileSaveAndConnectInput {
  // Both commands share the same shape; only command name differs.
  const base = {
    mode: plan.mode,
    profile_id: plan.profileId,
    persist_secrets: plan.persistSecrets,
    input: payload,
  } as const;

  // Keep explicit return types stable
  if (kind === "save_and_connect") {
    return base as unknown as ProfileSaveAndConnectInput;
  }
  return base as unknown as ProfileSaveInput;
}

/**
 * Unified core for:
 * - profileSave
 * - profileSaveAndConnect
 */
async function profileSaveCore<K extends SaveKind>(
  kind: K,
  input: SaveAndConnectInput & SaveAction
): Promise<SaveResultMap[K]> {
  const plan = buildSavePlan(input);

  return withKeychainRollback(plan, async () => {
    const payload = buildProfilePayload(input, plan);
    const cmdPayload = buildCmdPayload(kind, plan, payload);

    if (kind === "save_and_connect") {
      return (await invoke<ProfileSaveAndConnectResult>(
        CMD.profileSaveAndConnect,
        {
          payload: cmdPayload as ProfileSaveAndConnectInput,
        }
      )) as SaveResultMap[K];
    }

    return (await invoke<ConnectionProfile>(CMD.profileSave, {
      payload: cmdPayload as ProfileSaveInput,
    })) as SaveResultMap[K];
  });
}

/* ============================================================================
 * Public API
 * ============================================================================
 */

// Save profile only (no runtime connect)
export async function profileSave(
  input: SaveAndConnectInput & SaveAction
): Promise<ConnectionProfile> {
  const res = await profileSaveCore("save", input);

  return res;
}

// Save profile + runtime connect
export function profileSaveAndConnect(
  input: SaveAndConnectInput & SaveAction
): Promise<ProfileSaveAndConnectResult> {
  return profileSaveCore("save_and_connect", input);
}

export async function profileList(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>(CMD.profileList);
}

async function resolveSecretRefPlain(ref?: SecretRef | null): Promise<string> {
  if (!ref) return "";
  if (ref.kind === "inline") return ref.value ?? "";
  try {
    const key = (ref.value ?? "").trim();
    if (!key) return "";
    return await secretsGet(key);
  } catch {
    return "";
  }
}

function dbPasswordRef(input: ConnectionCreateInput): SecretRef | undefined {
  switch (input.engine) {
    case "postgres":
      return input.postgres?.password;
    case "mysql":
    case "mariadb":
      return input.mysql?.password;
    case "sqlserver":
      return input.sqlserver?.password;
    case "oracle":
      return input.oracle?.password;
    case "mongo":
      return input.mongo?.password;
    case "redis":
      return input.redis?.password;
    default:
      return undefined;
  }
}

/** Match form behavior: whether DB secret is persisted in OS keychain for this saved input. */
function inferStoreKeychainFromCreateInput(
  input: ConnectionCreateInput
): boolean {
  const e = input.engine;
  if (e === "postgres") return input.postgres?.password?.kind !== "inline";
  if (e === "mysql" || e === "mariadb")
    return input.mysql?.password?.kind !== "inline";
  if (e === "sqlserver") return input.sqlserver?.password?.kind !== "inline";
  if (e === "oracle") return input.oracle?.password?.kind !== "inline";
  if (e === "mongo") return input.mongo?.password?.kind !== "inline";
  if (e === "sqlite") return false;
  return true;
}

async function fetchProfileSecretsForDuplicate(
  profile: ConnectionProfile
): Promise<{ dbPassword: string; sshPassword: string }> {
  const input = profile.input;
  const dbPassword = await resolveSecretRefPlain(dbPasswordRef(input));

  let sshPassword = "";
  const ssh = input.ssh;
  if (ssh?.auth?.kind === "password") {
    sshPassword = await resolveSecretRefPlain(ssh.auth.password);
  }

  return { dbPassword, sshPassword };
}

/** Persist a new profile cloned from `profile` (label gets ` (copy)`). No UI. */
export async function duplicateProfile(
  profile: ConnectionProfile
): Promise<ConnectionProfile> {
  const input = structuredClone(profile.input) as ConnectionCreateInput;
  const baseLabel = (profile.label || input.label || "Connection").trim();
  input.label = baseLabel ? `${baseLabel} (copy)` : "Connection (copy)";

  const storeKeychain = inferStoreKeychainFromCreateInput(input);
  const { dbPassword, sshPassword } =
    await fetchProfileSecretsForDuplicate(profile);

  return profileSave({
    mode: "create",
    storeKeychain,
    password: dbPassword,
    ssh_password: sshPassword,
    ...input,
  });
}

export async function profileConnect(
  profileId: string
): Promise<ProfileConnectResult> {
  const payload: ProfileConnectInput = { profile_id: profileId };
  return invoke<ProfileConnectResult>(CMD.profileConnect, { payload });
}

export async function profileRemove(profileId: string): Promise<void> {
  await invoke(CMD.profileRemove, { profileId });
}

export async function profileExport(): Promise<string> {
  return invoke<string>(CMD.profileExport);
}

export async function profileExportOne(profileId: string): Promise<string> {
  return invoke<string>(CMD.profileExportOne, { profileId });
}

export type SharingExportSecretOptions = {
  includeDbPassword?: boolean;
  includeSshPassword?: boolean;
};

export async function profileExportOneEncrypted(
  profileId: string,
  password: string,
  options?: SharingExportSecretOptions
): Promise<string> {
  return invoke<string>(CMD.profileExportOneEncrypted, {
    profileId,
    password,
    includeDbPassword: !!options?.includeDbPassword,
    includeSshPassword: !!options?.includeSshPassword,
  });
}

export async function profileDecryptExport(
  encryptedJson: string,
  password: string
): Promise<string> {
  return invoke<string>(CMD.profileDecryptExport, { encryptedJson, password });
}

export async function profileIsEncryptedExport(json: string): Promise<boolean> {
  return invoke<boolean>(CMD.profileIsEncryptedExport, { json });
}

export async function profileImport(
  json: string
): Promise<ProfileImportResult> {
  return invoke<ProfileImportResult>(CMD.profileImport, {
    payload: { json },
  });
}

export async function profileImportExternal(
  path: string,
  password?: string
): Promise<ExternalImportResult> {
  return invoke<ExternalImportResult>(CMD.profileImportExternal, {
    payload: { path, password: password ?? null },
  });
}

export async function profileConnectTest(
  profileId: string,
  input: ConnectionCreateInput,
  secrets?: { dbPassword?: string; sshPassword?: string }
): Promise<void> {
  const payload: ProfileConnectTestInput = {
    profile_id: profileId,
    input,
    secrets: secrets
      ? ({
          db_password: secrets.dbPassword,
          ssh_password: secrets.sshPassword,
        } satisfies ConnectionTestSecrets)
      : undefined,
  };

  await invoke(CMD.profileConnectTest, { payload });
}
