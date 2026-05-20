/* ============================================================================
 * Shared FE Types (contract with Rust)
 * Keep this file “wire-format oriented”: only what we send/receive via Tauri.
 * UI-only helpers/types live at the bottom.
 * ============================================================================
 */

import { DatabaseEngine } from "src/types";

/* ============================================================================
 * Primitives
 * ============================================================================
 */

export type SslMode =
  | "disable"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full";

export type SecretRef =
  | { kind: "inline"; value: string }
  | { kind: "keychain"; value: string };

/* ============================================================================
 * SSH
 * ============================================================================
 */

export type StrictHostKeyChecking = "accept-new" | "yes" | "no";

export type SshAuth =
  | { kind: "password"; password: SecretRef }
  | {
      kind: "private_key";
      identity_file: string;
      passphrase?: SecretRef | null;
    };

export type SshTunnelInput = {
  // Optional convenience flag for UI; backend ignores it if present
  enabled?: boolean;

  ssh_host: string;
  ssh_port?: number | null; // default 22 (backend may default)
  ssh_user: string;

  auth: SshAuth;

  // Forward target (DB side)
  remote_host: string; // usually "127.0.0.1" if DB is on same server
  remote_port: number;

  strict_host_key_checking: StrictHostKeyChecking;

  // Optional: bind addr, default 127.0.0.1 (backend may ignore)
  local_bind_host?: string | null;

  // Optional: request local port, 0 => auto-pick free port (backend may ignore)
  local_bind_port?: number | null;

  connect_timeout_ms?: number | null;
};

/* ============================================================================
 * Engine connect inputs
 * ============================================================================
 */

export type PgConnectInput = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: SecretRef;

  ssl_mode?: SslMode;
  connect_timeout_ms?: number | null;
  statement_timeout_ms?: number | null;

  ssl_key_path?: string | null;
  ssl_cert_path?: string | null;
  ssl_ca_path?: string | null;

  pool_max_size?: number | null;
};

export type MySqlConnectInput = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: SecretRef;

  ssl_mode?: SslMode | null;

  connect_timeout_ms?: number | null;
  statement_timeout_ms?: number | null;
  pool_max_size?: number | null;

  ssl_key_path?: string | null;
  ssl_cert_path?: string | null;
  ssl_ca_path?: string | null;
};

export type RedisConnectInput = {
  host: string;
  port: number;

  // Redis ACL user is optional. If omitted => ":password@"
  user?: string | null;

  // Password is optional (some Redis instances allow no-auth),
  // but still modeled as SecretRef for uniformity.
  password: SecretRef;

  // Default 0
  db?: number | null;

  // Redis typically supports: disable / prefer / require.
  // Reuse SslMode union for FE convenience.
  ssl_mode?: "disable" | "prefer" | "require" | (SslMode & string) | null;

  connect_timeout_ms?: number | null;

  // Default per-connection timeout for Redis commands
  command_timeout_ms?: number | null;

  pool_max_size?: number | null;
};

export type MongoConnectInput = {
  host: string;
  port: number;
  database?: string | null;
  user?: string | null;
  password: SecretRef;
  ssl_mode?: SslMode | null;
  connect_timeout_ms?: number | null;
};

export type SqliteConnectInput = {
  path: string;
  statement_timeout_ms?: number | null;
};

export type DuckdbConnectInput = {
  path: string;
  statement_timeout_ms?: number | null;
};

export type D1ConnectInput = {
  account_id: string;
  database_id: string;
  api_token: SecretRef;
  api_base_url?: string | null;
  statement_timeout_ms?: number | null;
};

export type OracleConnectInput = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: SecretRef;
  connect_timeout_ms?: number | null;
  statement_timeout_ms?: number | null;
};

export type SqlServerConnectInput = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: SecretRef;
  encrypt?: boolean | null;
  connect_timeout_ms?: number | null;
  statement_timeout_ms?: number | null;
};

export type SnowflakeConnectInput = {
  account: string;
  warehouse: string;
  database: string;
  schema?: string | null;
  role?: string | null;
  user: string;
  password: SecretRef;
  connect_timeout_ms?: number | null;
  statement_timeout_ms?: number | null;
};

/* ============================================================================
 * Connection (runtime)
 * ============================================================================
 */

export type ConnectionCreateInput = {
  engine: DatabaseEngine;
  label: string;

  tags: string[];
  indicator_color: string;

  ssh?: SshTunnelInput;

  postgres?: PgConnectInput;
  mysql?: MySqlConnectInput;
  sqlserver?: SqlServerConnectInput;
  sqlite?: SqliteConnectInput;
  d1?: D1ConnectInput;
  oracle?: OracleConnectInput;
  mongo?: MongoConnectInput;
  redis?: RedisConnectInput;
  snowflake?: SnowflakeConnectInput;
  duckdb?: DuckdbConnectInput;
};

export type ConnectionInfo = {
  id: string;
  engine: DatabaseEngine;
  label: string;
};

/* ============================================================================
 * Connection Test
 * ============================================================================
 */

export type ConnectionTestSecrets = {
  db_password?: string;
  ssh_password?: string;
};

export type ConnectionTestInput = {
  input: ConnectionCreateInput;
  secrets?: ConnectionTestSecrets;
};

/* ============================================================================
 * Profiles (disk)
 * ============================================================================
 */

export type ConnectionProfile = {
  id: string;
  engine: DatabaseEngine;
  label: string;
  input: ConnectionCreateInput;
  tags?: string[];
  indicator_color?: string | null;
  created_at: number;
  updated_at: number;
};

export type ProfileImportResult = {
  created: number;
  updated: number;
  total: number;
  profiles: ConnectionProfile[];
};

export type ExternalImportSource = "dbeaver" | "tableplus";

export type ExternalImportResult = ProfileImportResult & {
  source: ExternalImportSource;
  skipped: number;
  skipped_reasons: string[];
  passwords_included: boolean;
};

export type ProfileConnectInput = {
  profile_id: string;
};

export type ProfileConnectResult = {
  profile: ConnectionProfile;
  connection: ConnectionInfo;
};

// Test by profile_id (backend loads profile and runs driver.test)
export type ProfileConnectTestInput = {
  profile_id: string;
  input: ConnectionCreateInput;
  secrets?: ConnectionTestSecrets; // optional
};

// If your backend returns nothing for test, keep Promise<void> on FE.
// If you return extra info later, change this.
export type ProfileConnectTestResult = void;

/* ============================================================================
 * Save flows
 * ============================================================================
 */

// Save-only (no runtime connect)
export type ProfileSaveInput =
  | {
      mode: "create";
      profile_id: string;
      persist_secrets: boolean;
      input: ConnectionCreateInput;
    }
  | {
      mode: "update";
      profile_id: string;
      persist_secrets: boolean;
      input: ConnectionCreateInput;
    };

// Save + connect (runtime)
export type ProfileSaveAndConnectInput =
  | {
      mode: "create";
      profile_id: string;
      persist_secrets: boolean;
      input: ConnectionCreateInput;
    }
  | {
      mode: "update";
      profile_id: string;
      persist_secrets: boolean;
      input: ConnectionCreateInput;
    };

export type ProfileSaveAndConnectResult = {
  profile: ConnectionProfile;
  connection: ConnectionInfo;
};

/* ============================================================================
 * Operations (SQL + Redis)
 * ============================================================================
 */

export type SqlQueryPayload = {
  sql: string;
  batch_size?: number;
  max_rows?: number;

  validate_only?: boolean;

  // Optional overrides (backend may ignore if unsupported)
  statement_timeout_ms?: number | null;
  client_mode?: "direct" | "stream";
};

export type RedisCommandPayload = {
  // Example: "KEYS", "SCAN", "GET", "HGETALL", "LRANGE", ...
  cmd: string;

  // All args are strings; FE should stringify numbers itself.
  args?: string[];

  batch_size?: number;
  max_rows?: number;

  // Optional override (fallback to connection.default_command_timeout_ms)
  command_timeout_ms?: number | null;

  pattern?: string | null;
  scan_count?: number | null;
};

export type OperationExecuteInput =
  | {
      connection_id: string;
      kind: "sql_query";
      sql: SqlQueryPayload;
    }
  | {
      connection_id: string;
      kind: "redis_command";
      redis: RedisCommandPayload;
    };

export type ColumnMeta = { name: string; db_type: string; readonly?: boolean };

export type TableChunk = {
  op_id: string;
  columns?: ColumnMeta[];
  rows: any[][];
  row_offset: number;
  seq: number;
};

export type RedisResult =
  | { op_id: string; kind: "value"; value: any }
  | { op_id: string; kind: "list"; items: any[] }
  | { op_id: string; kind: "table"; columns: ColumnMeta[]; rows: any[][] };

export type OperationDone = {
  op_id: string;
  truncated: boolean;
  row_count: number;
  elapsed_ms: number;
  columns?: ColumnMeta[] | null;
};

export type QueryResult = {
  columns: ColumnMeta[];
  rows: any[][];
  rowCount: number;
};

export type MongoCollectionOverview = {
  columns: ColumnMeta[];
  row_count: number;
};

export type SqlResultSlot = {
  index: number;
  sql: string;
  status: "queued" | "running" | "done" | "error";
  result?: QueryResult;
  error?: string;
  startedAt?: number;
  finishedAt?: number;

  opId?: string; // For Streaming / SELECT queries
  mode?: "direct" | "stream"; // To easily switch UI rendering
};

/* ============================================================================
 * UI-only types (never sent as-is to Rust)
 * ============================================================================
 */

export type SaveAndConnectInput = ConnectionCreateInput & {
  storeKeychain?: boolean;

  // Plaintext, FE only
  password?: string;

  // Optional FE-only: allow SSH password in same UI form
  ssh_password?: string;

  // Optional FE-only: passphrase for private key
  ssh_passphrase?: string;
};

export type SaveAndConnectAction =
  | { mode: "create"; profileId?: never }
  | { mode: "update"; profileId: string };

export type PrepareSecretOptions = {
  profileId: string;
  persistSecrets: boolean;

  // Base key for DB secret. You can derive SSH key from it if you want.
  keychainKey: string;

  // Plain DB password used only when persistSecrets=false
  passwordPlain: string;
};

// Optional convenience for your FE normalization layer
export type NormalizeTestSecrets = {
  dbPassword?: string;
  sshPassword?: string;
};
