use std::sync::Arc;
use std::time::Instant;

use futures_util::{pin_mut, StreamExt};
use tauri::Emitter;
use tokio::sync::mpsc;

use crate::engines::cancel::CancelHandle;
use crate::engines::postgres::row_codec;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error, emit_meta};
use crate::types::{CellValue, SqlQueryInput, TableChunk};

/* =============================================================================
 * Helpers
 * ============================================================================= */

fn is_cancelled(err: &tokio_postgres::Error) -> bool {
    if let Some(db) = err.as_db_error() {
        return db.code().code() == "57014"; // query_canceled
    }
    err.to_string().to_lowercase().contains("cancel")
}

/* =============================================================================
 * Runner
 * ============================================================================= */

pub async fn run_pg_sql_query(
    ctx: OperationCtx,
    pool: deadpool_postgres::Pool,
    sql_input: SqlQueryInput,
) {
    let op_id = ctx.op_id;
    let started_at = Instant::now();

    // Always clean active marker + pending cancel request, even if runner fails early.
    let _active_guard = ActiveGuard::new(
        op_id,
        Arc::clone(&ctx.active_ops),
        Arc::clone(&ctx.cancel_requested),
    );

    // Batch sizing + limits
    let batch_size: usize = sql_input.batch_size.unwrap_or(200).clamp(1, 2000) as usize;
    let max_rows: u64 = sql_input.max_rows.unwrap_or(50_000).clamp(1, 1_000_000) as u64;

    // Acquire client from pool
    let mut client = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            emit_error(&ctx.app, op_id, format!("POOL_GET_FAILED: {e}"), elapsed_ms);
            return;
        }
    };

    // Register cancel token (engine-agnostic cancel handle)
    let cancel_token = client.cancel_token();
    ctx.running_ops
        .insert(op_id, CancelHandle::Postgres(cancel_token.clone()));

    // Ensure running_ops cleaned once token exists
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));

    // If user requested cancel before token existed, cancel immediately (non-blocking)
    if ctx.cancel_requested.remove(&op_id).is_some() {
        CancelHandle::Postgres(cancel_token.clone()).cancel();
    }

    // Transaction for SET LOCAL scoping (won't leak to pooled connection)
    let tx = match client.transaction().await {
        Ok(t) => t,
        Err(e) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            emit_error(&ctx.app, op_id, format!("TX_BEGIN_FAILED: {e}"), elapsed_ms);
            return;
        }
    };

    // Optional read-only (best-effort; real enforcement should be DB roles)
    if sql_input.read_only.unwrap_or(false) {
        if let Err(e) = tx
            .batch_execute("SET LOCAL default_transaction_read_only = on")
            .await
        {
            let elapsed_ms = started_at.elapsed().as_millis();

            emit_error(
                &ctx.app,
                op_id,
                format!("SET_READ_ONLY_FAILED: {e}"),
                elapsed_ms,
            );
            return;
        }
    }

    // Scoped statement_timeout
    let statement_timeout_ms: u64 = sql_input
        .statement_timeout_ms
        .unwrap_or(60_000)
        .clamp(100, 300_000);

    if let Err(e) = tx
        .batch_execute(&format!(
            "SET LOCAL statement_timeout = {}",
            statement_timeout_ms
        ))
        .await
    {
        let elapsed_ms = started_at.elapsed().as_millis();

        emit_error(
            &ctx.app,
            op_id,
            format!("SET_STATEMENT_TIMEOUT_FAILED: {e}"),
            elapsed_ms,
        );
        return;
    }

    // Prepare statement (for column meta + precompiled decoders)
    let stmt = match tx.prepare(&sql_input.sql).await {
        Ok(s) => s,
        Err(e) => {
            let elapsed_ms = started_at.elapsed().as_millis();

            emit_error(&ctx.app, op_id, format!("PREPARE_FAILED: {e}"), elapsed_ms);
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
    let op_id2 = op_id;

    let emit_task = tokio::spawn(async move {
        while let Some(item) = rx_chunk.recv().await {
            match item {
                Ok(chunk) => {
                    // If FE is gone / window reloaded => stop consuming to backpressure producer
                    if app_emit.emit("op:chunk_table", chunk).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let elapsed_ms = started_at.elapsed().as_millis();

                    emit_error(&app_emit, op_id2, err, elapsed_ms);
                    break;
                }
            }
        }
    });

    // Query stream (no params for now)
    let stream = match tx.query_raw(&stmt, std::iter::empty::<&str>()).await {
        Ok(s) => s,
        Err(e) => {
            if is_cancelled(&e) {
                let elapsed_ms = started_at.elapsed().as_millis();
                emit_done(&ctx.app, op_id, false, 0, elapsed_ms);

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
    let mut batch_rows: Vec<Vec<CellValue>> = Vec::with_capacity(batch_size);

    // Adaptive batching
    let min_batch: usize = 50;
    let max_batch: usize = batch_size;
    let mut target_batch: usize = (batch_size / 2).max(min_batch).min(max_batch);

    while let Some(row_result) = stream.next().await {
        let row = match row_result {
            Ok(r) => r,
            Err(e) => {
                if is_cancelled(&e) {
                    let elapsed_ms = started_at.elapsed().as_millis();
                    emit_done(&ctx.app, op_id, false, row_count, elapsed_ms);

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

            // Adaptive tuning based on backpressure latency
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
        let _ = tx_chunk.send(Ok(chunk)).await;
    }

    // Commit (even for SELECT, commit ends SET LOCAL scope cleanly)
    if let Err(e) = tx.commit().await {
        let _ = tx_chunk.send(Err(format!("TX_COMMIT_FAILED: {e}"))).await;
        drop(tx_chunk);
        let _ = emit_task.await;
        return;
    }

    drop(tx_chunk);
    let _ = emit_task.await;

    let truncated = row_count == max_rows;
    let elapsed_ms = started_at.elapsed().as_millis();
    emit_done(&ctx.app, op_id, truncated, row_count, elapsed_ms);
}
