use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::operations;
use crate::state::AppState;
use crate::types::OperationExecuteInput;

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
pub async fn operation_cancel(state: State<'_, AppState>, op_id: Uuid) -> Result<(), String> {
    operations::cancel_operation(state, op_id).await
}
