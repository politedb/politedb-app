use std::sync::Arc;

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::operations::ctx::OperationCtx;
use crate::operations::emit::emit_started;
use crate::state::AppState;
use crate::types::{OperationExecuteInput, OperationKind};

pub async fn cancel_operation(state: State<'_, AppState>, op_id: Uuid) -> Result<(), String> {
    // Hard guarantee: free this op's sql_busy slot immediately on cancel,
    // before abort/teardown. OpCleanup only drops after the aborted task
    // finishes tearing down DB clients (can take many seconds). Without an
    // early release, cancel → re-export hits ERR_SQL_BUSY until that Drop.
    //
    // Use release_op (by owner id), NOT release_if_owner via op_to_conn:
    // mapping can already be cleared while the slot stays held. release_op
    // must run even when the op is unknown to active/task maps so busy-retry
    // cancel(holder) actually frees the slot (same ERR_SQL_BUSY uuid otherwise
    // loops forever). Idempotent if a newer stream already owns the conn.
    state.sql_busy.release_op(op_id);

    let known = state.active_ops.contains_key(&op_id)
        || state.op_tasks.contains_key(&op_id)
        || state.running_ops.contains_key(&op_id)
        || state.op_to_conn.contains_key(&op_id);
    if !known {
        return Ok(());
    }

    // Always mark cancel request to cover races (cancel before token exists).
    state.cancel_requested.insert(op_id, ());

    // If cancel handle exists -> request DB-side cancel immediately.
    if let Some(handle) = state.running_ops.get(&op_id).map(|e| e.value().clone()) {
        handle.cancel();
    }

    // If the task exists -> abort the async task as a fallback (covers "stuck before token").
    if let Some((_k, task)) = state.op_tasks.remove(&op_id) {
        task.abort();
    }

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
    let conn_id: Uuid = input.connection_id;

    /* ============================================================
     * SQL BUSY GUARD (ONLY FOR SQL QUERY)
     * - Register op->conn BEFORE acquire so cancel can always resolve the op
     * - Acquire BEFORE marking active / emitting started / spawning
     * ============================================================ */
    // ✅ determine is_stream from payload (only for SqlQuery)
    let is_stream_sql = match input.kind {
        OperationKind::SqlQuery => input.sql.as_ref().map(|s| s.is_stream()).unwrap_or(false),
        _ => false,
    };

    /* ============================================================
     * OP REGISTRATION (mapping first)
     * ============================================================ */

    // Map op -> connection BEFORE busy acquire so a concurrent busy-retry
    // cancel(holding_uuid) can find the op (and so cancel_requested races
    // during dispatch still see a known op).
    state.op_to_conn.insert(op_id, conn_id);

    // ✅ acquire only for stream
    if is_stream_sql {
        if let Err(e) = state.sql_busy.try_acquire(conn_id, op_id) {
            // TEMP: diagnose cancel→re-export busy races (remove after verified).
            eprintln!(
                "[sql_busy] try_acquire BUSY conn={} new_op={} err={}",
                conn_id, op_id, e
            );
            state.op_to_conn.remove(&op_id);
            return Err(e);
        }
        eprintln!("[sql_busy] try_acquire OK conn={} op={}", conn_id, op_id);
    }

    // Mark active
    state.active_ops.insert(op_id, ());

    // Emit started (if this fails, rollback state)
    if let Err(e) = emit_started(&app, op_id, conn_id) {
        // rollback op tracking
        state.active_ops.remove(&op_id);
        state.op_to_conn.remove(&op_id);

        state.running_ops.remove(&op_id);
        state.cancel_requested.remove(&op_id);
        state.flow_by_op.remove(&op_id);
        if let Some((_k, t)) = state.op_tasks.remove(&op_id) {
            t.abort();
        }

        // rollback busy lock
        if is_stream_sql {
            state.sql_busy.release_op(op_id);
        }

        return Err(e);
    }

    /* ============================================================
     * OP CONTEXT
     * ============================================================ */

    let ctx = OperationCtx {
        op_id,
        app: app.clone(),
        running_ops: Arc::clone(&state.running_ops),
        cancel_requested: Arc::clone(&state.cancel_requested),
        active_ops: Arc::clone(&state.active_ops),
        op_to_conn: Arc::clone(&state.op_to_conn),
        flow_by_op: Arc::clone(&state.flow_by_op),
        op_tasks: Arc::clone(&state.op_tasks),
        sql_busy: state.sql_busy.clone(),
    };

    /* ============================================================
     * SPAWN OPERATION
     * ============================================================ */

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

    /* ============================================================
     * SPAWN FAIL → ROLLBACK EVERYTHING
     * ============================================================ */

    if let Err(e) = spawn_res {
        state.active_ops.remove(&op_id);
        state.op_to_conn.remove(&op_id);

        state.running_ops.remove(&op_id);
        state.cancel_requested.remove(&op_id);
        state.flow_by_op.remove(&op_id);

        if let Some((_k, t)) = state.op_tasks.remove(&op_id) {
            t.abort();
        }

        // rollback busy lock
        if is_stream_sql {
            state.sql_busy.release_op(op_id);
        }

        return Err(e);
    }

    Ok(op_id)
}
