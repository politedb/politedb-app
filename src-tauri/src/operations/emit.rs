use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::types::{OperationDone, OperationError, OperationMeta, OperationStarted};

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

pub fn emit_meta(app: &AppHandle, op_id: Uuid, columns: Vec<crate::types::ColumnMeta>) {
    // Intentionally best-effort. If you want strictness, return Result and fail runner early.
    let _ = app.emit("op:meta", OperationMeta { op_id, columns });
}

pub fn emit_done(app: &AppHandle, op_id: Uuid, truncated: bool, row_count: u64) {
    let _ = app.emit(
        "op:done",
        OperationDone {
            op_id,
            truncated,
            row_count,
        },
    );
}

pub fn emit_error(app: &AppHandle, op_id: Uuid, msg: impl Into<String>) {
    let _ = app.emit(
        "op:error",
        OperationError {
            op_id,
            error: msg.into(),
        },
    );
}
