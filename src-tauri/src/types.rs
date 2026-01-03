use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Postgres,
    // Mysql,
    // Sqlite,
    // Redis,
    // Mongo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretRefKind {
    Inline,   // chỉ dùng khi user nhập tạm thời, không lưu
    Keychain, // production: lưu vào keychain
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretRef {
    pub kind: SecretRefKind,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgConnectInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,

    // Password có thể là inline (chỉ session) hoặc keychain ref
    pub password: SecretRef,

    // SSL mode đơn giản hoá: "disable" | "prefer" | "require"
    pub ssl_mode: Option<String>,
    pub ssl_key_path: Option<String>,
    pub ssl_cert_path: Option<String>,
    pub ssl_ca_path: Option<String>,

    pub pool_max_size: Option<usize>,
    // Optional client-side certificates (PEM-encoded)

    // Timeouts (ms)
    pub connect_timeout_ms: Option<u64>,
    pub statement_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionCreateInput {
    pub engine: EngineKind,
    pub label: String,
    pub postgres: Option<PgConnectInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub id: Uuid,
    pub engine: EngineKind,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    SqlQuery,
    // RedisCommand,
    // MongoFind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlQueryInput {
    pub sql: String,
    pub max_rows: Option<u32>,
    pub batch_size: Option<u32>,
    pub statement_timeout_ms: Option<u64>,
    pub read_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationExecuteInput {
    pub connection_id: Uuid,
    pub kind: OperationKind,
    pub sql: Option<SqlQueryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationStarted {
    pub op_id: Uuid,
    pub connection_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub db_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationMeta {
    pub op_id: Uuid,
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableChunk {
    pub op_id: uuid::Uuid,
    pub rows: Vec<Vec<CellValue>>,
    pub row_offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationDone {
    pub op_id: Uuid,
    pub truncated: bool,
    pub row_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationError {
    pub op_id: Uuid,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum CellValue {
    Null,
    Bool(bool),
    I64(i64),
    F64(f64),
    Str(String),

    /// For JSON/JSONB: we send it as a compact JSON string (avoid nested Value allocations)
    Json(String),

    /// For bytea or unknown binary: base64 string
    BytesB64(String),
}
