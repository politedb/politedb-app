import { Control, FieldErrors } from "react-hook-form";
import type {
  ConnectionCreateInput,
  ConnectionProfile,
  SslMode,
} from "src/lib/tauri";
import { normalizeTag, toNumber } from "src/utils/convert";
import type { DatabaseEngine } from "src/types";
import { SUPPORTED_DATABASES } from "src/constant";

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

  snowflakeWarehouse: string;
  snowflakeRole: string;
  snowflakeSchema: string;

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
    case "mariadb":
      return 3306;
    case "sqlserver":
      return 1433;
    case "mongo":
      return 27017;
    case "cassandra":
      return 9042;
    case "redis":
      return 6379;
    case "sqlite":
    case "d1":
    case "duckdb":
      return 0;
    case "oracle":
      return 1521;
    case "snowflake":
      return 0;
    case "clickhouse":
      return 8123;
    default:
      return 5432;
  }
}

function defaultHostForEngine(engine: DatabaseEngine): string {
  if (
    engine === "sqlite" ||
    engine === "d1" ||
    engine === "duckdb" ||
    engine === "snowflake"
  )
    return "";
  return "127.0.0.1";
}

function pickByEngine<T>(
  engine: DatabaseEngine,
  by: {
    postgres?: T;
    mysql?: T;
    sqlserver?: T;
    sqlite?: T;
    d1?: T;
    oracle?: T;
    mongo?: T;
    cassandra?: T;
    redis?: T;
    snowflake?: T;
    duckdb?: T;
    clickhouse?: T;
  }
): T | undefined {
  if (engine === "postgres") return by.postgres;
  if (engine === "mysql" || engine === "mariadb") return by.mysql;
  if (engine === "sqlserver") return by.sqlserver;
  if (engine === "sqlite") return by.sqlite;
  if (engine === "duckdb") return by.duckdb;
  if (engine === "d1") return by.d1;
  if (engine === "oracle") return by.oracle;
  if (engine === "mongo") return by.mongo;
  if (engine === "cassandra") return by.cassandra;
  if (engine === "redis") return by.redis;
  if (engine === "snowflake") return by.snowflake;
  if (engine === "clickhouse") return by.clickhouse;
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
    database: String(v.database ?? "").trim(),
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

function buildMySqlInput(
  v: FormValues,
  engine: "mysql" | "mariadb" = "mysql"
): ConnectionCreateInput {
  const port = toNumber(v.port, 3306);

  const mysql: ConnectionCreateInput["mysql"] = {
    host: v.host,
    port,
    database: String(v.database ?? "").trim(),
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    connect_timeout_ms: 60_000,
    ssl_mode: v.sslMode,
  };

  return {
    engine,
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    mysql,
    ssh: buildSshInput(v, v.host, port),
  };
}

function buildSqlServerInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 1433);

  const sqlserver: ConnectionCreateInput["sqlserver"] = {
    host: v.host,
    port,
    database: String(v.database ?? "").trim(),
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    encrypt: v.sslMode !== "disable",
    connect_timeout_ms: 60_000,
    statement_timeout_ms: 60_000,
  };

  return {
    engine: "sqlserver",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    sqlserver,
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
    ssl_mode: v.sslMode,
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

function buildCassandraInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 9042);

  const cassandra: ConnectionCreateInput["cassandra"] = {
    host: v.host,
    port,
    keyspace: v.database?.trim() || null,
    user: v.user?.trim() || null,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    connect_timeout_ms: 60_000,
    ssl_mode: v.sslMode,
  };

  return {
    engine: "cassandra",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    cassandra,
    ssh: buildSshInput(v, v.host, port),
  };
}

function buildMongoInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 27017);

  const mongo: ConnectionCreateInput["mongo"] = {
    host: v.host,
    port,
    database: v.database?.trim() || null,
    user: v.user?.trim() || null,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    connect_timeout_ms: 60_000,
    ssl_mode: v.sslMode,
  };

  return {
    engine: "mongo",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    mongo,
    ssh: buildSshInput(v, v.host, port),
  };
}

function buildSnowflakeInput(v: FormValues): ConnectionCreateInput {
  const snowflake: ConnectionCreateInput["snowflake"] = {
    account: String(v.host ?? "").trim(),
    warehouse: String(v.snowflakeWarehouse ?? "").trim(),
    database: String(v.database ?? "").trim(),
    schema: v.snowflakeSchema?.trim() || null,
    role: v.snowflakeRole?.trim() || null,
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    connect_timeout_ms: 60_000,
    statement_timeout_ms: 60_000,
  };

  return {
    engine: "snowflake",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    snowflake,
  };
}

function buildOracleInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 1521);

  const oracle: ConnectionCreateInput["oracle"] = {
    host: v.host,
    port,
    database: v.database?.trim() ?? "",
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    connect_timeout_ms: 60_000,
    statement_timeout_ms: 60_000,
  };

  return {
    engine: "oracle",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    oracle,
    ssh: buildSshInput(v, v.host, port),
  };
}

function buildSqliteInput(v: FormValues): ConnectionCreateInput {
  const path = String(v.database ?? "").trim();

  return {
    engine: "sqlite",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    sqlite: {
      path,
      statement_timeout_ms: 60_000,
    },
  };
}

function buildDuckdbInput(v: FormValues): ConnectionCreateInput {
  const path = String(v.database ?? "").trim();

  return {
    engine: "duckdb",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    duckdb: {
      path,
      statement_timeout_ms: 60_000,
    },
  };
}

function buildClickhouseInput(v: FormValues): ConnectionCreateInput {
  const port = toNumber(v.port, 8123);

  const clickhouse: ConnectionCreateInput["clickhouse"] = {
    host: v.host,
    port,
    database: String(v.database ?? "").trim(),
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    ssl_mode: v.sslMode,
    connect_timeout_ms: 60_000,
    statement_timeout_ms: 60_000,
  };

  return {
    engine: "clickhouse",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    clickhouse,
    ssh: buildSshInput(v, v.host, port),
  };
}

function buildD1Input(v: FormValues): ConnectionCreateInput {
  return {
    engine: "d1",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    d1: {
      account_id: String(v.host ?? "").trim(),
      database_id: String(v.database ?? "").trim(),
      api_token: v.storeKeychain
        ? { kind: "keychain", value: v.password }
        : { kind: "inline", value: v.password },
      statement_timeout_ms: 60_000,
    },
  };
}

export function buildConnectionInput(v: FormValues): ConnectionCreateInput {
  switch (v.engine) {
    case "postgres":
      return buildPostgresInput(v);
    case "mysql":
      return buildMySqlInput(v);
    case "mariadb":
      return buildMySqlInput(v, "mariadb");
    case "sqlserver":
      return buildSqlServerInput(v);
    case "mongo":
      return buildMongoInput(v);
    case "cassandra":
      return buildCassandraInput(v);
    case "sqlite":
      return buildSqliteInput(v);
    case "duckdb":
      return buildDuckdbInput(v);
    case "d1":
      return buildD1Input(v);
    case "oracle":
      return buildOracleInput(v);
    case "snowflake":
      return buildSnowflakeInput(v);
    case "redis":
      return buildRedisInput(v);
    case "clickhouse":
      return buildClickhouseInput(v);
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
  const ss = input?.sqlserver;
  const sqlite = input?.sqlite;
  const duckdb = input?.duckdb;
  const d1 = input?.d1;
  const oracle = input?.oracle;
  const mongo = input?.mongo;
  const cassandra = input?.cassandra;
  const rd = input?.redis;
  const sf = input?.snowflake;
  const ch = input?.clickhouse;

  const host =
    pickByEngine(engine, {
      postgres: pg?.host,
      mysql: my?.host,
      sqlserver: ss?.host,
      sqlite: "",
      d1: d1?.account_id,
      oracle: oracle?.host,
      mongo: mongo?.host,
      cassandra: cassandra?.host,
      redis: rd?.host,
      snowflake: sf?.account,
      clickhouse: ch?.host,
    }) || defaultHostForEngine(engine);

  const port =
    pickByEngine(engine, {
      postgres: pg?.port,
      mysql: my?.port,
      sqlserver: ss?.port,
      sqlite: 0,
      d1: 0,
      oracle: oracle?.port,
      mongo: mongo?.port,
      cassandra: cassandra?.port,
      redis: rd?.port,
      snowflake: 0,
      clickhouse: ch?.port,
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
    }) ||
    (engine === "mongo" ||
    engine === "cassandra" ||
    engine === "sqlite" ||
    engine === "duckdb" ||
    engine === "d1"
      ? ""
      : "root");

  const database =
    pickByEngine(engine, {
      postgres: pg?.database,
      mysql: my?.database,
      sqlserver: ss?.database,
      sqlite: sqlite?.path,
      duckdb: duckdb?.path,
      d1: d1?.database_id,
      oracle: oracle?.database,
      mongo: mongo?.database ?? undefined,
      cassandra: cassandra?.keyspace ?? undefined,
      snowflake: sf?.database,
      clickhouse: ch?.database,
    }) ||
    (engine === "mongo" ||
    engine === "cassandra" ||
    engine === "sqlite" ||
    engine === "duckdb" ||
    engine === "d1"
      ? ""
      : "root");

  const snowflakeWarehouse = sf?.warehouse ?? "";
  const snowflakeRole = sf?.role ?? "";
  const snowflakeSchema = sf?.schema ?? "PUBLIC";

  const password =
    engine === "postgres"
      ? pg?.password?.kind === "inline"
        ? (pg.password.value ?? "")
        : ""
      : engine === "mysql" || engine === "mariadb"
        ? my?.password?.kind === "inline"
          ? (my.password.value ?? "")
          : ""
        : engine === "sqlserver"
          ? ss?.password?.kind === "inline"
            ? (ss.password.value ?? "")
            : ""
          : engine === "oracle"
            ? oracle?.password?.kind === "inline"
              ? (oracle.password.value ?? "")
              : ""
            : engine === "snowflake"
              ? sf?.password?.kind === "inline"
                ? (sf.password.value ?? "")
                : ""
              : engine === "clickhouse"
                ? ch?.password?.kind === "inline"
                  ? (ch.password.value ?? "")
                  : ""
                : engine === "duckdb" || engine === "sqlite"
                  ? ""
                  : engine === "mongo"
                    ? mongo?.password?.kind === "inline"
                      ? (mongo.password.value ?? "")
                      : ""
                    : engine === "cassandra"
                      ? cassandra?.password?.kind === "inline"
                        ? (cassandra.password.value ?? "")
                        : ""
                      : engine === "d1"
                        ? d1?.api_token?.kind === "inline"
                          ? (d1.api_token.value ?? "")
                          : ""
                        : "";

  const storeKeychain =
    engine === "postgres"
      ? pg?.password?.kind !== "inline"
      : engine === "mysql" || engine === "mariadb"
        ? my?.password?.kind !== "inline"
        : engine === "sqlserver"
          ? ss?.password?.kind !== "inline"
          : engine === "oracle"
            ? oracle?.password?.kind !== "inline"
            : engine === "snowflake"
              ? sf?.password?.kind !== "inline"
              : engine === "clickhouse"
                ? ch?.password?.kind !== "inline"
                : engine === "duckdb" || engine === "sqlite"
                  ? false
                  : engine === "mongo"
                    ? mongo?.password?.kind !== "inline"
                    : engine === "cassandra"
                      ? cassandra?.password?.kind !== "inline"
                      : engine === "d1"
                        ? d1?.api_token?.kind !== "inline"
                        : true;

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

  // Redis/Mongo: default to "disable" so local instances work without TLS.
  // Postgres/MySQL keep "prefer" for smoother dev/prod behavior.
  const defaultSsl =
    engine === "redis" || engine === "mongo" || engine === "cassandra"
      ? ("disable" as const)
      : ("prefer" as const);

  const sslMode: FormValues["sslMode"] = ssl_mode ?? defaultSsl;

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
