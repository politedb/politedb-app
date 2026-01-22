use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::cell::{CellValue, ColumnMeta};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationStarted {
    pub op_id: Uuid,
    pub connection_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationDone {
    pub op_id: Uuid,
    pub truncated: bool,
    pub row_count: u64,
    pub elapsed_ms: u128,
    pub columns: Option<Vec<ColumnMeta>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationError {
    pub op_id: Uuid,
    pub error: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableChunk {
    pub op_id: Uuid,
    pub rows: Vec<Vec<CellValue>>,
    pub row_offset: u64,
    pub seq: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TableChunkAckInput {
    pub op_id: Uuid,
    // How many credits to return. FE can ack per chunk (=1) or batch acks.
    pub permits: Option<u32>,
}
