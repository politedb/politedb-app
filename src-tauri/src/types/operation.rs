use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    SqlQuery,
    RedisCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlQueryInput {
    pub sql: String,
    pub max_rows: Option<u32>,
    pub batch_size: Option<u32>,
    pub statement_timeout_ms: Option<u64>,
    pub read_only: Option<bool>,
}

#[derive(Clone, serde::Deserialize)]
pub struct RedisCommandInput {
    /// Raw Redis command, e.g. "GET", "HGETALL", "SCAN"
    pub cmd: String,

    /// Command arguments (strings). For binary, FE should base64 and add a flag later.
    pub args: Vec<String>,

    /// Optional: chunk batching for table output
    pub batch_size: Option<u32>,

    /// Optional: max output rows (prevents huge scan)
    pub max_rows: Option<u64>,

    /// Optional: per-op override timeout (ms)
    pub command_timeout_ms: Option<u64>,

    /// Optional: for SCAN / HSCAN pattern
    pub pattern: Option<String>,

    /// Optional: SCAN COUNT hint
    pub scan_count: Option<u32>,
}

#[derive(Clone, serde::Deserialize)]
pub struct OperationExecuteInput {
    pub connection_id: Uuid,
    pub kind: OperationKind,

    pub sql: Option<SqlQueryInput>,
    pub redis: Option<RedisCommandInput>,
}
