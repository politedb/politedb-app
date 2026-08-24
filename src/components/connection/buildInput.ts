import type {
  ClickHouseConnectInput,
  ClickHouseProtocol,
  ConnectionCreateInput,
} from "src/lib/tauri";
import { normalizeTag, toNumber } from "src/utils/convert";
import type { DatabaseEngine } from "src/types";
import type { FormValues } from "./types";

export function defaultPortForEngine(engine: DatabaseEngine): number {
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
    case "turso":
    case "duckdb":
      return 0;
    case "oracle":
      return 1521;
    case "snowflake":
    case "google_sheets":
      return 0;
    case "clickhouse":
      return 9000;
    default:
      return 5432;
  }
}

export function defaultHostForEngine(engine: DatabaseEngine): string {
  if (
    engine === "sqlite" ||
    engine === "d1" ||
    engine === "duckdb" ||
    engine === "snowflake" ||
    engine === "google_sheets"
  ) {
    return "";
  }

  if (engine === "turso") {
    return "http://127.0.0.1:8080";
  }

  return "127.0.0.1";
}

export function pickByEngine<T>(
  engine: DatabaseEngine,
  by: {
    postgres?: T;
    mysql?: T;
    sqlserver?: T;
    sqlite?: T;
    d1?: T;
    turso?: T;
    oracle?: T;
    mongo?: T;
    cassandra?: T;
    redis?: T;
    snowflake?: T;
    duckdb?: T;
    clickhouse?: T;
    google_sheets?: T;
  }
): T | undefined {
  if (engine === "postgres") return by.postgres;
  if (engine === "mysql" || engine === "mariadb") return by.mysql;
  if (engine === "sqlserver") return by.sqlserver;
  if (engine === "sqlite") return by.sqlite;
  if (engine === "duckdb") return by.duckdb;
  if (engine === "d1") return by.d1;
  if (engine === "turso") return by.turso;
  if (engine === "oracle") return by.oracle;
  if (engine === "mongo") return by.mongo;
  if (engine === "cassandra") return by.cassandra;
  if (engine === "redis") return by.redis;
  if (engine === "snowflake") return by.snowflake;
  if (engine === "clickhouse") return by.clickhouse;
  if (engine === "google_sheets") return by.google_sheets;
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

export function defaultClickHousePort(protocol: ClickHouseProtocol): number {
  return protocol === "http" ? 8123 : 9000;
}

export function resolveClickhouseProtocol(
  ch?: ClickHouseConnectInput | null
): ClickHouseProtocol {
  if (ch?.protocol === "http" || ch?.protocol === "native") {
    return ch.protocol;
  }
  const port = ch?.port ?? 0;
  if (port === 8123 || port === 8443) return "http";
  return "native";
}

function buildClickhouseInput(v: FormValues): ConnectionCreateInput {
  const protocol = v.clickhouseProtocol;
  const port = toNumber(v.port, defaultClickHousePort(protocol));

  const clickhouse: ConnectionCreateInput["clickhouse"] = {
    host: v.host,
    port,
    database: String(v.database ?? "").trim(),
    user: v.user,
    password: v.storeKeychain
      ? { kind: "keychain", value: v.password }
      : { kind: "inline", value: v.password },
    protocol,
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

function buildTursoInput(v: FormValues): ConnectionCreateInput {
  return {
    engine: "turso",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    turso: {
      url: String(v.host ?? "").trim(),
      auth_token: v.storeKeychain
        ? { kind: "keychain", value: v.password }
        : { kind: "inline", value: v.password },
      statement_timeout_ms: 60_000,
    },
  };
}

function buildGoogleSheetsInput(v: FormValues): ConnectionCreateInput {
  return {
    engine: "google_sheets",
    label: v.name,
    tags: v.tags.map(normalizeTag),
    indicator_color: v.indicator_color,
    google_sheets: {
      spreadsheet_id: String(v.database ?? "").trim(),
      credential: v.storeKeychain
        ? { kind: "keychain", value: v.password }
        : { kind: "inline", value: v.password },
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
    case "turso":
      return buildTursoInput(v);
    case "oracle":
      return buildOracleInput(v);
    case "snowflake":
      return buildSnowflakeInput(v);
    case "redis":
      return buildRedisInput(v);
    case "clickhouse":
      return buildClickhouseInput(v);
    case "google_sheets":
      return buildGoogleSheetsInput(v);
    default:
      throw new Error(`Unsupported engine: ${String(v.engine)}`);
  }
}
