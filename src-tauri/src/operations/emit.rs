use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::types::{ColumnMeta, OperationDone, OperationError, OperationStarted};

pub fn emit_started(app: &AppHandle, op_id: Uuid, connection_id: Uuid) -> Result<(), String> {
    app.emit(
        "op:started",
        OperationStarted {
            op_id,
            connection_id,
        },
    )
    .map_err(|e| e.to_string())
}

pub fn emit_done(
    app: &AppHandle,
    op_id: Uuid,
    truncated: bool,
    row_count: u64,
    elapsed_ms: u128,
    columns: Option<Vec<ColumnMeta>>,
) {
    let _ = app.emit(
        "op:done",
        OperationDone {
            op_id,
            truncated,
            row_count,
            elapsed_ms,
            columns,
        },
    );
}

pub fn emit_error(app: &AppHandle, op_id: Uuid, msg: impl Into<String>, elapsed_ms: u128) {
    let _ = app.emit(
        "op:error",
        OperationError {
            op_id,
            error: msg.into(),
            elapsed_ms,
        },
    );
}
