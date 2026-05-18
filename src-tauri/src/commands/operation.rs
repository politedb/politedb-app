use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::operations;
use crate::state::AppState;
use crate::types::{OperationExecuteInput, SqlTransactionExecuteInput, TableChunkAckInput};

/* ============================================================================
 * Operation commands (thin wrappers)
 * ============================================================================
 */

#[tauri::command]
pub async fn operation_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    input: OperationExecuteInput,
) -> Result<Uuid, String> {
    operations::dispatch_operation(app, state, input).await
}

#[tauri::command]
pub async fn operation_execute_transaction(
    state: State<'_, AppState>,
    input: SqlTransactionExecuteInput,
) -> Result<(), String> {
    let conn = state
        .connections
        .get(&input.connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?
        .clone();

    conn.execute_sql_transaction(input.statements).await
}

#[tauri::command]
pub async fn operation_cancel(state: State<'_, AppState>, op_id: Uuid) -> Result<(), String> {
    operations::cancel_operation(state, op_id).await
}

#[tauri::command]
pub fn operation_chunk_ack(state: State<'_, AppState>, input: TableChunkAckInput) {
    let permits = input.permits.unwrap_or(1).clamp(1, 32) as usize; // cap burst acks

    if let Some(flow) = state.flow_by_op.get(&input.op_id) {
        flow.ack(permits);
    }
}
