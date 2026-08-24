import type {
  ConnectionCreateInput,
  ConnectionProfile,
  SslMode,
} from "src/lib/tauri";
import { normalizeTag } from "src/utils/convert";
import type { DatabaseEngine } from "src/types";
import { SUPPORTED_DATABASES } from "src/constant";
import type { FormValues } from "./types";
import {
  defaultHostForEngine,
  defaultPortForEngine,
  pickByEngine,
  resolveClickhouseProtocol,
} from "./buildInput";
import { dedupeKeepOrder } from "./dedupe";
import {
  defaultCredentialDatabase,
  defaultCredentialUser,
} from "src/lib/engines";
import { getConnectionFormEngineConfig } from "./engineFormConfig";

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
  const ss = input?.sqlserver;
  const sqlite = input?.sqlite;
  const duckdb = input?.duckdb;
  const d1 = input?.d1;
  const turso = input?.turso;
  const oracle = input?.oracle;
  const mongo = input?.mongo;
  const cassandra = input?.cassandra;
  const rd = input?.redis;
  const sf = input?.snowflake;
  const ch = input?.clickhouse;
  const sheets = input?.google_sheets;

  const host =
    pickByEngine(engine, {
      postgres: pg?.host,
      mysql: my?.host,
      sqlserver: ss?.host,
      sqlite: "",
      d1: d1?.account_id,
      turso: turso?.url,
      oracle: oracle?.host,
      mongo: mongo?.host,
      cassandra: cassandra?.host,
      redis: rd?.host,
      snowflake: sf?.account,
      clickhouse: ch?.host,
      google_sheets: "",
    }) || defaultHostForEngine(engine);

  const port =
    pickByEngine(engine, {
      postgres: pg?.port,
      mysql: my?.port,
      sqlserver: ss?.port,
      sqlite: 0,
      d1: 0,
      turso: 0,
      oracle: oracle?.port,
      mongo: mongo?.port,
      cassandra: cassandra?.port,
      redis: rd?.port,
      snowflake: 0,
      clickhouse: ch?.port,
      google_sheets: 0,
    }) ?? defaultPortForEngine(engine);

  const user =
    pickByEngine(engine, {
      postgres: pg?.user,
      mysql: my?.user,
      sqlserver: ss?.user,
      sqlite: "",
      oracle: oracle?.user,
      mongo: mongo?.user,
      cassandra: cassandra?.user,
      redis: rd?.user,
      snowflake: sf?.user,
      clickhouse: ch?.user,
      google_sheets: "",
    }) || defaultCredentialUser(engine);

  const database =
    pickByEngine(engine, {
      postgres: pg?.database,
      mysql: my?.database,
      sqlserver: ss?.database,
      sqlite: sqlite?.path,
      duckdb: duckdb?.path,
      d1: d1?.database_id,
      turso: "",
      oracle: oracle?.database,
      mongo: mongo?.database ?? undefined,
      cassandra: cassandra?.keyspace ?? undefined,
      snowflake: sf?.database,
      clickhouse: ch?.database,
      google_sheets: sheets?.spreadsheet_id,
    }) || defaultCredentialDatabase(engine);

  const snowflakeWarehouse = sf?.warehouse ?? "";
  const snowflakeRole = sf?.role ?? "";
  const snowflakeSchema = sf?.schema ?? "PUBLIC";

  const resolveInline = (
    value: { kind?: string; value?: string | null } | undefined | null
  ) => (value?.kind === "inline" ? (value.value ?? "") : "");
  const resolveStoreKeychain = (
    value: { kind?: string } | undefined | null,
    fallback = true
  ) => (value ? value.kind !== "inline" : fallback);

  let password = "";
  let storeKeychain = true;
  switch (engine) {
    case "postgres":
      password = resolveInline(pg?.password);
      storeKeychain = resolveStoreKeychain(pg?.password);
      break;
    case "mysql":
    case "mariadb":
      password = resolveInline(my?.password);
      storeKeychain = resolveStoreKeychain(my?.password);
      break;
    case "sqlserver":
      password = resolveInline(ss?.password);
      storeKeychain = resolveStoreKeychain(ss?.password);
      break;
    case "oracle":
      password = resolveInline(oracle?.password);
      storeKeychain = resolveStoreKeychain(oracle?.password);
      break;
    case "snowflake":
      password = resolveInline(sf?.password);
      storeKeychain = resolveStoreKeychain(sf?.password);
      break;
    case "clickhouse":
      password = resolveInline(ch?.password);
      storeKeychain = resolveStoreKeychain(ch?.password);
      break;
    case "mongo":
      password = resolveInline(mongo?.password);
      storeKeychain = resolveStoreKeychain(mongo?.password);
      break;
    case "cassandra":
      password = resolveInline(cassandra?.password);
      storeKeychain = resolveStoreKeychain(cassandra?.password);
      break;
    case "d1":
      password = resolveInline(d1?.api_token);
      storeKeychain = resolveStoreKeychain(d1?.api_token);
      break;
    case "turso":
      password = resolveInline(turso?.auth_token);
      storeKeychain = resolveStoreKeychain(turso?.auth_token);
      break;
    case "google_sheets":
      password = resolveInline(sheets?.credential);
      storeKeychain = resolveStoreKeychain(sheets?.credential);
      break;
    case "duckdb":
    case "sqlite":
      password = "";
      storeKeychain = false;
      break;
    default:
      password = "";
      storeKeychain = true;
      break;
  }

  return {
    host,
    port,
    user,
    database,
    password,
    storeKeychain,
    snowflakeWarehouse,
    snowflakeRole,
    snowflakeSchema,
  };
}

function makeSslDefaults(
  engine: DatabaseEngine,
  input?: ConnectionCreateInput
) {
  const pg = input?.postgres;
  const my = input?.mysql;
  const ss = input?.sqlserver;
  const mongo = input?.mongo;
  const cassandra = input?.cassandra;
  const rd = input?.redis;

  const ssl_mode = pickByEngine<FormValues["sslMode"]>(engine, {
    postgres: pg?.ssl_mode as SslMode | undefined,
    mysql: my?.ssl_mode as SslMode | undefined,
    sqlserver: ss?.encrypt === false ? "disable" : "prefer",
    oracle: undefined,
    mongo: mongo?.ssl_mode as SslMode | undefined,
    cassandra: cassandra?.ssl_mode as SslMode | undefined,
    redis: rd?.ssl_mode as SslMode | undefined,
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

  const defaultSslMode = getConnectionFormEngineConfig(engine).defaultSslMode;
  const sslMode: FormValues["sslMode"] = ssl_mode ?? defaultSslMode;

  return {
    sslMode,
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
    snowflakeWarehouse: db.snowflakeWarehouse,
    snowflakeRole: db.snowflakeRole,
    snowflakeSchema: db.snowflakeSchema,

    clickhouseProtocol:
      engine === "clickhouse"
        ? resolveClickhouseProtocol(input?.clickhouse)
        : "native",

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
