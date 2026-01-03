use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    SqlQuery,
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
