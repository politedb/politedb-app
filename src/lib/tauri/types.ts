/* ============================================================================
 * Shared FE Types (contract with Rust)
 * ============================================================================
 */

export type Engine = "postgres" | "mysql" | "redis" | string;

export type SslMode =
  | "disable"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full";

export type SecretRef =
  | { kind: "inline"; value: string }
  | { kind: "keychain"; value: string };

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

  // Password is optional (some Redis instances allow no-auth)
  password: SecretRef;

  // default 0
  db?: number | null;

  // For Redis we only care disable / prefer / require.
  // Still reuse SslMode union for FE convenience.
  ssl_mode?: "disable" | "prefer" | "require" | (SslMode & string) | null;

  connect_timeout_ms?: number | null;

  // Default per-connection timeout for Redis commands
  command_timeout_ms?: number | null;
};

export type ConnectionCreateInput = {
  engine: Engine;
  label: string;

  ssh?: SshTunnelInput;

  postgres?: PgConnectInput;
  mysql?: MySqlConnectInput;
  redis?: RedisConnectInput;
};

export type ConnectionInfo = {
  id: string;
  engine: Engine;
  label: string;
};

/* ============================================================================
 * Profiles (disk)
 * ============================================================================
 */

export type ConnectionProfile = {
  id: string;
  engine: Engine;
  label: string;
  input: ConnectionCreateInput;
  created_at: number;
  updated_at: number;
};

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
 * UI-only types (never sent as-is to Rust)
 * ============================================================================
 */

export type SaveAndConnectInput = ConnectionCreateInput & {
  storeKeychain: boolean;
  password?: string; // plaintext, FE only
  //   keychainKey: string; // required when storeKeychain=true
};

export type SaveAndConnectAction =
  | { mode: "create"; profileId?: never }
  | { mode: "update"; profileId: string };

/* ============================================================================
 * Operations (SQL + Redis)
 * ============================================================================
 */

export type SqlQueryPayload = {
  sql: string;
  batch_size?: number;
  max_rows?: number;

  // optional overrides (backend may ignore if unsupported)
  statement_timeout_ms?: number | null;
};

export type RedisCommandPayload = {
  // Example: "KEYS", "SCAN", "GET", "HGETALL", "LRANGE", ...
  command: string;

  // All args are strings; FE should stringify numbers itself.
  args?: string[];

  // optional override (fallback to connection.default_command_timeout_ms)
  command_timeout_ms?: number | null;

  // Optional: if backend supports selecting db per command (usually it won’t; it’s per-conn)
  db?: number | null;
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

export type ColumnMeta = { name: string; db_type: string };

/**
 * TableChunk is used for SQL results (postgres/mysql) AND also can be reused
 * for Redis “tabular outputs” if you decide (e.g. HGETALL => key/value rows).
 *
 * Note: columns is optional in some of your runtime events; keep it optional for safety.
 */
export type TableChunk = {
  op_id: string;
  columns?: ColumnMeta[];
  rows: any[][];
  row_offset: number;
};

/**
 * Redis often returns:
 * - single value (GET)
 * - list of values (KEYS/SMEMBERS/LRANGE…)
 * - map-ish (HGETALL)
 *
 * Keep the FE contract stable:
 * - redis_result.kind tells FE how to render
 * - values are CellValue-like, but FE can treat as `any` if you haven’t typed CellValue yet
 */
export type RedisResult =
  | { op_id: string; kind: "value"; value: any }
  | { op_id: string; kind: "list"; items: any[] }
  | { op_id: string; kind: "table"; columns: ColumnMeta[]; rows: any[][] };

/**
 * OperationDone event stays shared.
 */
export type OperationDone = {
  op_id: string;
  truncated: boolean;
  row_count: number;
};

export type SshAuth =
  | { kind: "password"; password: SecretRef }
  | {
      kind: "private_key";
      private_key_path: string;
      passphrase?: SecretRef | null;
    };

export type StrictHostKeyChecking = "accept-new" | "yes" | "no";

export type SshTunnelInput = {
  enabled: boolean;

  ssh_host: string;
  ssh_port?: number | null; // default 22
  ssh_user: string;

  // optional: jump host later (ProxyJump) - để sau
  auth: SshAuth;

  // forward target (db side)
  target_host: string; // usually "127.0.0.1" if DB is on same server
  target_port: number;

  // optional: bind addr, default 127.0.0.1
  local_bind_host?: string | null;
  strict_host_key_checking: StrictHostKeyChecking;

  // optional: request local port, 0 => auto-pick free port
  local_bind_port?: number | null;

  connect_timeout_ms?: number | null;
};
