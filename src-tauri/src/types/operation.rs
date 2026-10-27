use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    SqlQuery,
    RedisCommand,
    /// PostgreSQL EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of a read-only
    /// statement, in a read-only transaction that is always rolled back.
    ExplainAnalyze,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlQueryInput {
    pub sql: String,
    pub max_rows: Option<u32>,
    pub batch_size: Option<u32>,
    pub statement_timeout_ms: Option<u64>,
    /// How long to wait for a lock before failing (PostgreSQL only). Lets
    /// read-only diagnostics skip a relation another session holds exclusively
    /// instead of waiting for the statement timeout.
    #[serde(default)]
    pub lock_timeout_ms: Option<u64>,
    pub read_only: Option<bool>,
    /// Write values in fixed text formats regardless of the session's
    /// settings (PostgreSQL only: ISO dates, ISO 8601 intervals, exact
    /// floats). Backups read text that must restore anywhere.
    #[serde(default)]
    pub canonical_text_output: Option<bool>,
    pub validate_only: Option<bool>,
    #[serde(default)]
    pub client_mode: Option<String>, // "direct" | "stream"
}

impl SqlQueryInput {
    pub fn is_stream(&self) -> bool {
        matches!(self.client_mode.as_deref(), Some("stream"))
    }
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
    #[serde(default)]
    pub explain_analyze: Option<ExplainAnalyzeInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainAnalyzeInput {
    /// The user's statement (not wrapped); the backend classifies and wraps it.
    pub sql: String,
}

#[derive(Clone, serde::Deserialize)]
pub struct SqlTransactionExecuteInput {
    pub connection_id: Uuid,
    pub statements: Vec<String>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportNullMode {
    EmptyString,
    EmptyAsNull,
}

#[derive(Clone, serde::Deserialize)]
pub struct SqlImportColumnInput {
    pub name: String,
    pub db_type: String,
}

#[derive(Clone, serde::Deserialize)]
pub struct SqlImportCsvInput {
    pub connection_id: Uuid,
    pub engine: crate::types::EngineKind,
    pub schema: String,
    pub table_name: String,
    pub columns: Vec<SqlImportColumnInput>,
    pub column_mapping: HashMap<String, Option<usize>>,
    pub null_mode: ImportNullMode,
    pub first_is_headers: bool,
    pub full_validation: bool,
    pub csv_text: String,
    /// Field separator the preview used (",", ";", "\t", "|"); comma when absent.
    #[serde(default)]
    pub delimiter: Option<String>,
}

#[derive(Clone, serde::Serialize)]
pub struct SqlImportCsvResult {
    pub imported: usize,
}
