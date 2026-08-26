import type { DatabaseEngine } from "src/types";
import type { FormValues } from "./types";

export type ConnectionFormEngineConfig = {
  basicsHint: string;
  requiredHint: string;
  nameLabel: string;
  databaseUserLabel: string;
  databasePlaceholder: string;
  credentialLabel: string;
  credentialPlaceholder: string;
  authOptional: boolean;
  fileless: boolean;
  showHostPort: boolean;
  showDatabaseUser: boolean;
  showCredential: boolean;
  showSsl: boolean;
  showSsh: boolean;
  defaultSslMode: FormValues["sslMode"];
};

const NETWORK_SQL_CONFIG: ConnectionFormEngineConfig = {
  basicsHint: "Host, Port, User (database optional)",
  requiredHint: "Required: Host, Port, User.",
  nameLabel: "Name",
  databaseUserLabel: "Database / User",
  databasePlaceholder: "database",
  credentialLabel: "Password",
  credentialPlaceholder: "password",
  authOptional: false,
  fileless: false,
  showHostPort: true,
  showDatabaseUser: true,
  showCredential: true,
  showSsl: true,
  showSsh: true,
  defaultSslMode: "prefer",
};

const FILE_DATABASE_CONFIG: ConnectionFormEngineConfig = {
  ...NETWORK_SQL_CONFIG,
  basicsHint: "Database file path",
  requiredHint: "Required: Database file path.",
  databaseUserLabel: "Database Path",
  credentialLabel: "Password",
  authOptional: true,
  fileless: true,
  showHostPort: false,
  showDatabaseUser: true,
  showCredential: false,
  showSsl: false,
  showSsh: false,
};

export const CONNECTION_FORM_ENGINE_CONFIG: Record<
  DatabaseEngine,
  ConnectionFormEngineConfig
> = {
  postgres: NETWORK_SQL_CONFIG,
  mysql: NETWORK_SQL_CONFIG,
  mariadb: NETWORK_SQL_CONFIG,
  sqlserver: NETWORK_SQL_CONFIG,
  oracle: NETWORK_SQL_CONFIG,
  clickhouse: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Driver + host/port",
    nameLabel: "Name / Driver",
  },
  redis: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Host, Port (database optional)",
    requiredHint: "Required: Host, Port.",
    databaseUserLabel: "User",
    authOptional: true,
    defaultSslMode: "disable",
  },
  mongo: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Host, Port (database optional)",
    requiredHint: "Required: Host, Port.",
    authOptional: true,
    defaultSslMode: "disable",
  },
  cassandra: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Host, Port (keyspace optional)",
    requiredHint: "Required: Host, Port.",
    databasePlaceholder: "keyspace (optional)",
    authOptional: true,
    defaultSslMode: "disable",
  },
  sqlite: {
    ...FILE_DATABASE_CONFIG,
    databasePlaceholder: "/absolute/path/to/file.db",
  },
  duckdb: {
    ...FILE_DATABASE_CONFIG,
    databasePlaceholder: "/absolute/path/to/file.duckdb",
  },
  d1: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Cloudflare account, database, API token",
    requiredHint: "Required: Account ID, Database ID, API token.",
    credentialLabel: "API Token",
    credentialPlaceholder: "API token",
    fileless: true,
    showHostPort: false,
    showDatabaseUser: false,
    showSsh: false,
  },
  turso: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Database URL and auth token",
    requiredHint: "Required: Database URL, Auth token.",
    credentialLabel: "Auth Token",
    credentialPlaceholder: "Auth token",
    fileless: true,
    showHostPort: false,
    showDatabaseUser: false,
    showSsh: false,
  },
  snowflake: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Account, warehouse, database, user",
    requiredHint: "Required: Account, warehouse, database, user.",
    fileless: true,
    showHostPort: false,
    showDatabaseUser: false,
    showSsl: false,
  },
  google_sheets: {
    ...NETWORK_SQL_CONFIG,
    basicsHint: "Spreadsheet URL and Google credential",
    requiredHint:
      "Required: Spreadsheet ID or URL. API key for public sheets only or OAuth token for private sheets.",
    credentialLabel: "API Key (public) / OAuth Token (private)",
    credentialPlaceholder: "API key or OAuth access token",
    fileless: true,
    showHostPort: false,
    showDatabaseUser: false,
    showSsl: false,
    showSsh: false,
  },
};

export function getConnectionFormEngineConfig(
  engine: DatabaseEngine
): ConnectionFormEngineConfig {
  return CONNECTION_FORM_ENGINE_CONFIG[engine];
}

export function getCredentialInputPlaceholder(
  config: ConnectionFormEngineConfig,
  storeKeychain: boolean
) {
  if (config.credentialLabel !== "Password") {
    return config.credentialPlaceholder;
  }
  return storeKeychain
    ? "Enter password (save in Keychain)"
    : "Enter password (not saved)";
}

export function hasRequiredConnectionFields(values: FormValues): boolean {
  const config = getConnectionFormEngineConfig(values.engine);
  const host = values.host?.trim();
  const user = values.user?.trim();
  const database = values.database?.trim();
  const hasCredential = !!values.password?.trim() || values.storeKeychain;
  const hasHostPort = !!host && Number.isFinite(Number(values.port));

  switch (values.engine) {
    case "sqlite":
    case "duckdb":
      return !!database;
    case "d1":
      return !!host && !!database && hasCredential;
    case "turso":
      return !!host && hasCredential;
    case "snowflake":
      return (
        !!host &&
        !!database &&
        !!user &&
        !!values.snowflakeWarehouse?.trim() &&
        hasCredential
      );
    case "google_sheets":
      return !!database && hasCredential;
    default:
      return config.authOptional ? hasHostPort : hasHostPort && !!user;
  }
}
