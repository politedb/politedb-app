use std::sync::Arc;

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::operations::ctx::OperationCtx;
use crate::operations::emit::emit_started;
use crate::state::AppState;
use crate::types::{OperationExecuteInput, OperationKind};

pub async fn cancel_operation(state: State<'_, AppState>, op_id: Uuid) -> Result<(), String> {
    if !state.active_ops.contains_key(&op_id) {
        return Ok(());
    }

    if let Some(handle) = state.running_ops.get(&op_id).map(|e| e.value().clone()) {
        handle.cancel();
        return Ok(());
    }

    state.cancel_requested.insert(op_id, ());
    Ok(())
}

pub async fn dispatch_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    input: OperationExecuteInput,
) -> Result<Uuid, String> {
    let conn = state
        .connections
        .get(&input.connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?
        .clone();

    let op_id = Uuid::new_v4();

    // Map op -> connection ASAP (so connection_remove can cancel correctly)
    state.op_to_conn.insert(op_id, input.connection_id);

    // Mark active
    state.active_ops.insert(op_id, ());

    // Emit started (if this fails, rollback state)
    if let Err(e) = emit_started(&app, op_id, input.connection_id) {
        state.active_ops.remove(&op_id);
        state.op_to_conn.remove(&op_id); // ✅ rollback mapping
        return Err(e);
    }

    let ctx = OperationCtx {
        op_id,
        app: app.clone(),
        running_ops: Arc::clone(&state.running_ops),
        cancel_requested: Arc::clone(&state.cancel_requested),
        active_ops: Arc::clone(&state.active_ops),
        op_to_conn: Arc::clone(&state.op_to_conn),
    };

    let spawn_res: Result<(), String> = match input.kind {
        OperationKind::SqlQuery => {
            let sql_input = input.sql.ok_or("SQL_PAYLOAD_MISSING")?;
            conn.spawn_sql_query(ctx, sql_input)
        }
        OperationKind::RedisCommand => {
            let cmd_input = input.redis.ok_or("REDIS_PAYLOAD_MISSING")?;
            conn.spawn_redis_command(ctx, cmd_input)
        }
    };

    // If spawn fails, rollback op tracking
    if let Err(e) = spawn_res {
        state.active_ops.remove(&op_id);
        state.op_to_conn.remove(&op_id); // ✅ rollback mapping

        // Optional hygiene (in case spawn_* inserted some handles before failing)
        state.running_ops.remove(&op_id);
        state.cancel_requested.remove(&op_id);

        return Err(e);
    }

    Ok(op_id)
}
