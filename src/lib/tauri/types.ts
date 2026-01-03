/* ============================================================================
 * Shared FE Types (contract with Rust)
 * ============================================================================
 */

export type Engine = "postgres" | "mysql" | string;
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

export type ConnectionCreateInput = {
  engine: Engine;
  label: string;
  postgres?: PgConnectInput;
  mysql?: MySqlConnectInput;
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
  | { mode: "create"; input: ConnectionCreateInput }
  | { mode: "update"; profile_id: string; input: ConnectionCreateInput };

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
  keychainKey: string; // required when storeKeychain=true
};

export type SaveAndConnectAction =
  | { mode: "create"; profileId?: never }
  | { mode: "update"; profileId: string };

/* ============================================================================
 * Operations
 * ============================================================================
 */

export type SqlQueryPayload = {
  sql: string;
  batch_size?: number;
  max_rows?: number;
};

export type OperationExecuteInput = {
  connection_id: string;
  kind: "sql_query";
  sql: SqlQueryPayload;
};

export type ColumnMeta = { name: string; db_type: string };

export type TableChunk = {
  op_id: string;
  columns: ColumnMeta[];
  rows: any[][];
  row_offset: number;
};

export type OperationDone = {
  op_id: string;
  truncated: boolean;
  row_count: number;
};
