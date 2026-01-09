import { Control, FieldErrors } from "react-hook-form";
import type {
  ConnectionCreateInput,
  ConnectionProfile,
  SslMode,
} from "src/lib/tauri";
import { toNumber } from "src/utils/convert";
import { DatabaseEngine } from "src/types";
import { SUPPORTED_DATABASES } from "../../constant";

/* =============================================================================
 * Types
 * ============================================================================= */

export type FormValues = {
  engine: DatabaseEngine;
  name: string;

  tags: string[];
  indicator_color: string;

  host: string;
  port: number;
  user: string;
  password: string;
  database: string;

  storeKeychain: boolean;

  sslMode: SslMode;
  sslKey: string;
  sslCert: string;
  sslCA: string;

  sshAuthType: "password" | "privateKey" | "privateKeyWithPassphrase";
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  sshPassword: string;
  sshPasswordSaveMethod: "keychain" | "inline";
};

export type SectionProps = {
  control: Control<FormValues>;
  errors?: FieldErrors<FormValues>;
  onDirty?: () => void;
};

/* =============================================================================
 * Small utils
 * ============================================================================= */

export function normalizeTag(s: string) {
  return s
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .toLowerCase();
}

export function dedupeKeepOrder(xs: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function defaultPortForEngine(engine: DatabaseEngine): number {
  switch (engine) {
    case "postgres":
      return 5432;
    case "mysql":
      return 3306;
    case "redis":
      return 6379;
    default:
      return 5432;
  }
}

function defaultHostForEngine(_engine: DatabaseEngine): string {
  return "127.0.0.1";
}

function pickByEngine<T>(
  engine: DatabaseEngine,
  by: { postgres?: T; mysql?: T; redis?: T }
): T | undefined {
  if (engine === "postgres") return by.postgres;
  if (engine === "mysql") return by.mysql;
  if (engine === "redis") return by.redis;
  return undefined;
}

/* =============================================================================
 * Build input (submit)
 * ============================================================================= */

function buildSshAuth(v: FormValues) {
  if (v.sshAuthType === "privateKey") {
    return { kind: "private_key" as const, identity_file: v.sshKeyPath };
  }

  // password
  return {
    kind: "password" as const,
    password:
      v.sshPasswordSaveMethod === "keychain"
        ? { kind: "keychain" as const, value: v.sshPassword }
        : { kind: "inline" as const, value: v.sshPassword },
  };
}

function buildSshInput(
  v: FormValues,
  remote_host: string,
  remote_port: number
) {
  if (!v.sshEnabled) return undefined;

  return {
    ssh_host: v.sshHost,
    ssh_port: toNumber(v.sshPort, 22),
    ssh_user: v.sshUser?.trim() || "root",
    auth: buildSshAuth(v),
    strict_host_key_checking: "accept-new" as const,
    connect_timeout_ms: 60_000,
    remote_host,
    remote_port,
  };
}

// export function buildConnectionInput(v: FormValues): ConnectionCreateInput {
//   const port = toNumber(v.port, 5432);

//   const postgres: ConnectionCreateInput["postgres"] = {
//     host: v.host,
//     port,
//     database: v.database,
//     user: v.user,
//     password: v.storeKeychain
//       ? { kind: "keychain", value: v.password } // still use password field to carry keychain key
//       : { kind: "inline", value: v.password },
//     ssl_mode: v.sslMode,
//     connect_timeout_ms: 60_000,
//     statement_timeout_ms: 0,
//     ssl_key_path: v.sslKey || null,
//     ssl_cert_path: v.sslCert || null,
//     ssl_ca_path: v.sslCA || null,
//   };

//   return {
//     engine: "postgres",
//     label: v.name,
//     tags: v.tags.map(normalizeTag),
//     indicator_color: v.indicator_color,
//     postgres,
//     ssh: buildSshInput(v, v.host, port),
//   };
// }

function buildPostgresInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 5432);

  const postgres: ConnectionCreateInput["postgres"] = {
    host: v.host,
    port,
    database: v.database,
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    ssl_mode: v.sslMode,
    connect_timeout_ms: 60_000,
    statement_timeout_ms: 0,
    ssl_key_path: v.sslKey || null,
    ssl_cert_path: v.sslCert || null,
    ssl_ca_path: v.sslCA || null,
  };

  return {
    engine: "postgres",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    postgres,
    ssh: buildSshInput(v, v.host, port),
  };
}

function buildMySqlInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 3306);

  const mysql: ConnectionCreateInput["mysql"] = {
    host: v.host,
    port,
    database: v.database,
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    connect_timeout_ms: 60_000,
    ssl_mode: v.sslMode,
  };

  return {
    engine: "mysql",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    mysql,
    ssh: buildSshInput(v, v.host, port),
  };
}

function buildRedisInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 6379);

  const redis: ConnectionCreateInput["redis"] = {
    host: v.host,
    port,
    db: toNumber(v.database, 0),
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
  };

  return {
    engine: "redis",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    redis,
    ssh: buildSshInput(v, v.host, port),
  };
}

export function buildConnectionInput(v: FormValues): ConnectionCreateInput {
  switch (v.engine) {
    case "postgres":
      return buildPostgresInput(v);
    case "mysql":
      return buildMySqlInput(v);
    case "redis":
      return buildRedisInput(v);
    default:
      throw new Error(`Unsupported engine: ${String(v.engine)}`);
  }
}

/* =============================================================================
 * Defaults (load profile -> form)
 * ============================================================================= */

function getEngineFromProfile(p?: ConnectionProfile): DatabaseEngine {
  return (
    (p?.input?.engine as DatabaseEngine) ||
    (p?.engine as DatabaseEngine) ||
    "postgres"
  );
}

function makeDbDefaults(engine: DatabaseEngine, input?: ConnectionCreateInput) {
  const pg = input?.postgres;
  const my = input?.mysql;
  const rd = input?.redis;

  const host =
    pickByEngine(engine, {
      postgres: pg?.host,
      mysql: my?.host,
      redis: rd?.host,
    }) || defaultHostForEngine(engine);

  const port =
    pickByEngine(engine, {
      postgres: pg?.port,
      mysql: my?.port,
      redis: rd?.port,
    }) ?? defaultPortForEngine(engine);

  const user =
    pickByEngine(engine, { postgres: pg?.user, mysql: my?.user }) || "root";

  const database =
    pickByEngine(engine, { postgres: pg?.database, mysql: my?.database }) ||
    "root";

  const password =
    engine === "postgres"
      ? pg?.password?.kind === "inline"
        ? (pg.password.value ?? "")
        : ""
      : engine === "mysql"
        ? my?.password?.kind === "inline"
          ? (my.password.value ?? "")
          : ""
        : "";

  const storeKeychain =
    engine === "postgres"
      ? pg?.password?.kind !== "inline"
      : engine === "mysql"
        ? my?.password?.kind !== "inline"
        : true;

  return { host, port, user, database, password, storeKeychain };
}

function makeSslDefaults(
  engine: DatabaseEngine,
  input?: ConnectionCreateInput
) {
  const pg = input?.postgres;
  const my = input?.mysql;

  const ssl_mode = pickByEngine(engine, {
    postgres: pg?.ssl_mode as SslMode | undefined,
    mysql: my?.ssl_mode as SslMode | undefined,
  });

  const ssl_key_path = pickByEngine(engine, {
    postgres: pg?.ssl_key_path ?? undefined,
    mysql: my?.ssl_key_path ?? undefined,
  });

  const ssl_cert_path = pickByEngine(engine, {
    postgres: pg?.ssl_cert_path ?? undefined,
    mysql: my?.ssl_cert_path ?? undefined,
  });

  const ssl_ca_path = pickByEngine(engine, {
    postgres: pg?.ssl_ca_path ?? undefined,
    mysql: my?.ssl_ca_path ?? undefined,
  });

  return {
    sslMode: ssl_mode || "prefer",
    sslKey: ssl_key_path || "",
    sslCert: ssl_cert_path || "",
    sslCA: ssl_ca_path || "",
  };
}

function makeSshDefaults(input?: ConnectionCreateInput) {
  const ssh = input?.ssh;

  const sshAuthType: FormValues["sshAuthType"] =
    ssh?.auth?.kind === "password" ? "password" : "privateKey";

  const sshPasswordSaveMethod: FormValues["sshPasswordSaveMethod"] =
    ssh?.auth?.kind === "password" && ssh.auth.password?.kind === "inline"
      ? "inline"
      : "keychain";

  const sshPassword =
    ssh?.auth?.kind === "password" && ssh.auth.password?.kind === "inline"
      ? (ssh.auth.password.value ?? "")
      : "";

  const sshKeyPath =
    ssh?.auth?.kind === "private_key" ? ssh.auth.identity_file || "" : "";

  return {
    sshEnabled: !!ssh,
    sshHost: ssh?.ssh_host || "",
    sshPort: ssh?.ssh_port ?? 22,
    sshUser: ssh?.ssh_user || "",
    sshAuthType,
    sshKeyPath,
    sshPassword,
    sshPasswordSaveMethod,
  };
}

export function makeDefaultValues(
  initialData?: ConnectionProfile,
  initialEngine?: DatabaseEngine
): FormValues {
  const input = initialData?.input;
  const engine = initialEngine || getEngineFromProfile(initialData);

  const db = makeDbDefaults(engine, input);
  const ssl = makeSslDefaults(engine, input);
  const ssh = makeSshDefaults(input);

  const initialTags =
    input?.tags.length == 0 ? ["local"] : (input?.tags ?? ["local"]);

  return {
    engine,
    name: input?.label || initialData?.label || pickDefaultLabel(engine),
    tags: dedupeKeepOrder(initialTags.map(normalizeTag)),
    indicator_color: input?.indicator_color || "",

    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,

    storeKeychain: db.storeKeychain,

    ...ssl,
    ...ssh,
  };
}

export function pickDefaultLabel(engine?: DatabaseEngine): string {
  const FALLBACK_LABEL = "Aether";
  if (!engine) return FALLBACK_LABEL;

  const db = SUPPORTED_DATABASES.find((d) => d.engine === engine);
  if (!db || !db.defaultLabels?.length) return FALLBACK_LABEL;

  return db.defaultLabels[0];
}
