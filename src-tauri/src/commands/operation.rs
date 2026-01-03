use std::sync::Arc;
use std::time::Instant;

use futures_util::{pin_mut, StreamExt};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::engines::postgres::row_codec;
use crate::engines::EngineConnection;
use crate::state::AppState;
use crate::types::{
    ColumnMeta, OperationDone, OperationError, OperationExecuteInput, OperationKind, OperationMeta,
    OperationStarted, TableChunk,
};

/* =============================================================================
 * Emit helpers
 * ============================================================================= */

fn emit_started(app: &AppHandle, op_id: Uuid, connection_id: Uuid) -> Result<(), String> {
    app.emit(
        "op:started",
        OperationStarted {
            op_id,
            connection_id,
        },
    )
    .map_err(|e| e.to_string())
}

fn emit_meta(app: &AppHandle, op_id: Uuid, columns: Vec<ColumnMeta>) {
    let _ = app.emit("op:meta", OperationMeta { op_id, columns });
}

fn emit_done(app: &AppHandle, op_id: Uuid, truncated: bool, row_count: u64) {
    let _ = app.emit(
        "op:done",
        OperationDone {
            op_id,
            truncated,
            row_count,
        },
    );
}

fn emit_error(app: &AppHandle, op_id: Uuid, msg: impl Into<String>) {
    let _ = app.emit(
        "op:error",
        OperationError {
            op_id,
            error: msg.into(),
        },
    );
}

fn is_cancelled(err: &tokio_postgres::Error) -> bool {
    if let Some(db) = err.as_db_error() {
        return db.code().code() == "57014"; // query_canceled
    }
    err.to_string().to_lowercase().contains("cancel")
}

/* =============================================================================
 * Operation context + guards
 * ============================================================================= */

struct OperationCtx {
    op_id: Uuid,
    app: AppHandle,
    running_ops: Arc<dashmap::DashMap<Uuid, tokio_postgres::CancelToken>>,
    cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
}

/// Always clean active marker + pending cancel request, even if runner fails early.
struct ActiveGuard {
    op_id: Uuid,
    active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
    cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.active_ops.remove(&self.op_id);
        self.cancel_requested.remove(&self.op_id);
    }
}

/// Clean running_ops once cancel token exists.
struct RunningGuard {
    op_id: Uuid,
    running_ops: Arc<dashmap::DashMap<Uuid, tokio_postgres::CancelToken>>,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.running_ops.remove(&self.op_id);
    }
}

/* =============================================================================
 * Commands
 * ============================================================================= */

/// Cancel a running operation (hard cancel for Postgres)
#[tauri::command]
pub async fn operation_cancel(state: State<'_, AppState>, op_id: Uuid) -> Result<(), String> {
    // If op is not active anymore, ignore (prevents leaking cancel_requested)
    if !state.active_ops.contains_key(&op_id) {
        return Ok(());
    }

    // If token already exists, cancel immediately
    if let Some(token) = state.running_ops.get(&op_id).map(|e| e.value().clone()) {
        tokio::spawn(async move {
            let _ = token.cancel_query(tokio_postgres::NoTls).await;
        });
        return Ok(());
    }

    // Token not yet available => remember cancel request
    state.cancel_requested.insert(op_id, ());
    Ok(())
}

/// Execute an operation (Postgres SQL for now, multi-engine ready)
#[tauri::command]
pub async fn operation_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    input: OperationExecuteInput,
) -> Result<Uuid, String> {
    // 1) Resolve connection
    let conn = state
        .connections
        .get(&input.connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?
        .clone();

    // 2) Create op id + mark active immediately
    let op_id = Uuid::new_v4();
    state.active_ops.insert(op_id, ());

    // emit_started may fail => rollback active marker
    if let Err(e) = emit_started(&app, op_id, input.connection_id) {
        state.active_ops.remove(&op_id);
        return Err(e);
    }

    // 3) Create operation context for spawned runner
    let ctx = OperationCtx {
        op_id,
        app: app.clone(),
        running_ops: Arc::clone(&state.running_ops),
        cancel_requested: Arc::clone(&state.cancel_requested),
        active_ops: Arc::clone(&state.active_ops),
    };

    // 4) Dispatch by kind/engine
    match (input.kind, conn) {
        (OperationKind::SqlQuery, EngineConnection::Postgres(pg)) => {
            let sql_input = input.sql.ok_or("SQL_PAYLOAD_MISSING")?;
            let pool = pg.pool.clone();

            tokio::spawn(async move {
                run_pg_sql_query(ctx, pool, sql_input).await;
            });

            Ok(op_id)
        }
        _ => {
            state.active_ops.remove(&op_id);
            Err("ENGINE_OPERATION_NOT_SUPPORTED".into())
        }
    }
}

/* =============================================================================
 * Runner
 * ============================================================================= */

async fn run_pg_sql_query(
    ctx: OperationCtx,
    pool: deadpool_postgres::Pool,
    sql_input: crate::types::SqlQueryInput,
) {
    let op_id = ctx.op_id;

    // Ensure active_ops/cancel_requested cleaned even if we fail before getting a client/token
    let _active_guard = ActiveGuard {
        op_id,
        active_ops: Arc::clone(&ctx.active_ops),
        cancel_requested: Arc::clone(&ctx.cancel_requested),
    };

    // Batch sizing + limits
    let batch_size = sql_input.batch_size.unwrap_or(200).clamp(1, 2000) as usize;
    let max_rows = sql_input.max_rows.unwrap_or(50_000).clamp(1, 1_000_000) as u64;

    // Acquire client from pool
    let mut client = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            emit_error(&ctx.app, op_id, format!("POOL_GET_FAILED: {e}"));
            return;
        }
    };

    // Register cancel token + ensure cleanup (now token exists)
    let cancel_token = client.cancel_token();
    ctx.running_ops.insert(op_id, cancel_token.clone());

    let _running_guard = RunningGuard {
        op_id,
        running_ops: Arc::clone(&ctx.running_ops),
    };

    // If user requested cancel before token existed, cancel immediately
    if ctx.cancel_requested.remove(&op_id).is_some() {
        tokio::spawn(async move {
            let _ = cancel_token.cancel_query(tokio_postgres::NoTls).await;
        });
    }

    // Transaction for SET LOCAL scoping
    let tx = match client.transaction().await {
        Ok(t) => t,
        Err(e) => {
            emit_error(&ctx.app, op_id, format!("TX_BEGIN_FAILED: {e}"));
            return;
        }
    };

    let read_only = sql_input.read_only.unwrap_or(false);
    if read_only {
        if let Err(e) = tx
            .batch_execute("SET LOCAL default_transaction_read_only = on")
            .await
        {
            emit_error(&ctx.app, op_id, format!("SET_READ_ONLY_FAILED: {e}"));
            return;
        }
    }

    // Scoped timeout
    let statement_timeout_ms: u64 = sql_input
        .statement_timeout_ms
        .unwrap_or(60_000)
        .clamp(100, 300_000);
    let sql = format!("SET LOCAL statement_timeout = {}", statement_timeout_ms);
    if let Err(e) = tx.batch_execute(&sql).await {
        emit_error(
            &ctx.app,
            op_id,
            format!("SET_STATEMENT_TIMEOUT_FAILED: {e}"),
        );
        return;
    }

    // Prepare statement
    let stmt = match tx.prepare(&sql_input.sql).await {
        Ok(s) => s,
        Err(e) => {
            emit_error(&ctx.app, op_id, format!("PREPARE_FAILED: {e}"));
            return;
        }
    };

    // Emit meta once + precompiled decoders
    let (meta, decoders) = row_codec::build_meta_and_decoders(&stmt);
    emit_meta(&ctx.app, op_id, meta);

    // Backpressure channel (inflight chunks)
    let (tx_chunk, mut rx_chunk) = mpsc::channel::<Result<TableChunk, String>>(2);

    // Serialize event emission on one task
    let app_emit = ctx.app.clone();
    let emit_task = tokio::spawn(async move {
        while let Some(item) = rx_chunk.recv().await {
            match item {
                Ok(chunk) => {
                    let _ = app_emit.emit("op:chunk_table", chunk);
                }
                Err(err) => {
                    emit_error(&app_emit, op_id, err);
                    break;
                }
            }
        }
    });

    // Query stream
    let stream = match tx.query_raw(&stmt, std::iter::empty::<&str>()).await {
        Ok(s) => s,
        Err(e) => {
            if is_cancelled(&e) {
                emit_done(&ctx.app, op_id, false, 0);
                drop(tx_chunk);
                let _ = emit_task.await;
                return;
            }
            let _ = tx_chunk.send(Err(format!("QUERY_FAILED: {e}"))).await;
            drop(tx_chunk);
            let _ = emit_task.await;
            return;
        }
    };

    pin_mut!(stream);

    let mut row_count: u64 = 0;
    let mut row_offset: u64 = 0;

    let mut batch_rows: Vec<Vec<crate::types::CellValue>> = Vec::with_capacity(batch_size);

    // Adaptive batching
    let min_batch: usize = 50;
    let max_batch: usize = batch_size;
    let mut target_batch: usize = (batch_size / 2).max(min_batch).min(max_batch);

    while let Some(row_result) = stream.next().await {
        let row = match row_result {
            Ok(r) => r,
            Err(e) => {
                if is_cancelled(&e) {
                    emit_done(&ctx.app, op_id, false, row_count);
                    drop(tx_chunk);
                    let _ = emit_task.await;
                    return;
                }
                let _ = tx_chunk.send(Err(format!("ROW_STREAM_FAILED: {e}"))).await;
                drop(tx_chunk);
                let _ = emit_task.await;
                return;
            }
        };

        if row_count >= max_rows {
            break;
        }

        batch_rows.push(row_codec::row_to_cells_with_decoders(&row, &decoders));
        row_count += 1;

        if batch_rows.len() >= target_batch {
            let chunk = TableChunk {
                op_id,
                rows: std::mem::take(&mut batch_rows),
                row_offset,
            };
            row_offset = row_count;

            let t0 = Instant::now();
            let sent = tx_chunk.send(Ok(chunk)).await;
            let dt = t0.elapsed();

            if sent.is_err() {
                drop(tx_chunk);
                let _ = emit_task.await;
                return;
            }

            if dt.as_millis() >= 30 {
                target_batch = (target_batch / 2).max(min_batch);
            } else if dt.as_millis() <= 5 {
                target_batch = (target_batch * 2).min(max_batch);
            }
        }
    }

    // Flush remaining
    if !batch_rows.is_empty() {
        let chunk = TableChunk {
            op_id,
            rows: batch_rows,
            row_offset,
        };
        if tx_chunk.send(Ok(chunk)).await.is_err() {
            drop(tx_chunk);
            let _ = emit_task.await;
            return;
        }
    }

    // Commit
    if let Err(e) = tx.commit().await {
        let _ = tx_chunk.send(Err(format!("TX_COMMIT_FAILED: {e}"))).await;
        drop(tx_chunk);
        let _ = emit_task.await;
        return;
    }

    drop(tx_chunk);
    let _ = emit_task.await;

    let truncated = row_count == max_rows;
    emit_done(&ctx.app, op_id, truncated, row_count);
}
