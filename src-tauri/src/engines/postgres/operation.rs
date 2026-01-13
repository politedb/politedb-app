use std::sync::Arc;
use std::time::Instant;

use futures_util::{pin_mut, StreamExt};
use tauri::Emitter;
use tokio::sync::mpsc;

use crate::engines::cancel::CancelHandle;
use crate::engines::postgres::row_codec;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, SqlQueryInput, TableChunk};
use tokio_postgres::error::ErrorPosition;
/* =============================================================================
 * Helpers
 * ============================================================================= */

fn is_cancelled(err: &tokio_postgres::Error) -> bool {
    if let Some(db) = err.as_db_error() {
        return db.code().code() == "57014"; // query_canceled
    }
    err.to_string().to_lowercase().contains("cancel")
}

fn is_explainable(sql: &str) -> bool {
    // Best-effort heuristic: EXPLAIN supports SELECT and most DML in Postgres.
    // DDL not reliably explainable.
    let s = sql.trim_start();
    if s.is_empty() {
        return false;
    }
    let up = s.chars().take(24).collect::<String>().to_uppercase();

    up.starts_with("SELECT")
        || up.starts_with("WITH")
        || up.starts_with("INSERT")
        || up.starts_with("UPDATE")
        || up.starts_with("DELETE")
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

    let validate_only = sql_input.validate_only.unwrap_or(false);

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
            emit_error(
                &ctx.app,
                op_id,
                format_pg_error(&e, &sql_input.sql),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    // Optional read-only (best-effort; real enforcement should be DB roles)
    if sql_input.read_only.unwrap_or(false) {
        if let Err(e) = tx
            .batch_execute("SET LOCAL default_transaction_read_only = on")
            .await
        {
            emit_error(
                &ctx.app,
                op_id,
                format!("SET_READ_ONLY_FAILED: {e}"),
                started_at.elapsed().as_millis(),
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
        emit_error(
            &ctx.app,
            op_id,
            format_pg_error(&e, &sql_input.sql),
            started_at.elapsed().as_millis(),
        );
        return;
    }

    // PREPARE catches syntax errors early
    let stmt = match tx.prepare(&sql_input.sql).await {
        Ok(s) => s,
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format_pg_error(&e, &sql_input.sql),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    // Build meta + decoders (meta shipped in op:done)
    let (meta, decoders) = row_codec::build_meta_and_decoders(&stmt);
    let done_columns = Some(meta.clone());

    /* =========================================================================
     * ✅ Validation-only path (no chunks, no row fetch)
     * ========================================================================= */
    if validate_only {
        // Best-effort semantic validation: EXPLAIN for explainable statements.
        if is_explainable(&sql_input.sql) {
            let explain_sql = format!("EXPLAIN {}", sql_input.sql);

            if let Err(e) = tx.batch_execute(&explain_sql).await {
                if is_cancelled(&e) {
                    emit_done(
                        &ctx.app,
                        op_id,
                        false,
                        0,
                        started_at.elapsed().as_millis(),
                        done_columns,
                    );
                    return;
                }

                emit_error(
                    &ctx.app,
                    op_id,
                    format_pg_error(&e, &sql_input.sql),
                    started_at.elapsed().as_millis(),
                );
                return;
            }
        }

        // Commit to end SET LOCAL scope cleanly
        if let Err(e) = tx.commit().await {
            emit_error(
                &ctx.app,
                op_id,
                format!("TX_COMMIT_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }

        emit_done(
            &ctx.app,
            op_id,
            false,
            0,
            started_at.elapsed().as_millis(),
            done_columns,
        );
        return;
    }

    /* =========================================================================
     * Execute path (stream rows -> chunk -> done)
     * ========================================================================= */

    let (tx_chunk, mut rx_chunk) = mpsc::channel::<Result<TableChunk, String>>(2);

    // Serialize event emission on one task
    let app_emit = ctx.app.clone();
    let op_id2 = op_id;

    let emit_task = tokio::spawn(async move {
        while let Some(item) = rx_chunk.recv().await {
            match item {
                Ok(chunk) => {
                    if app_emit.emit("op:chunk_table", chunk).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    emit_error(&app_emit, op_id2, err, started_at.elapsed().as_millis());
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
                emit_done(
                    &ctx.app,
                    op_id,
                    false,
                    0,
                    started_at.elapsed().as_millis(),
                    done_columns.clone(),
                );

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
                    emit_done(
                        &ctx.app,
                        op_id,
                        false,
                        row_count,
                        started_at.elapsed().as_millis(),
                        done_columns.clone(),
                    );

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
    emit_done(
        &ctx.app,
        op_id,
        truncated,
        row_count,
        started_at.elapsed().as_millis(),
        done_columns.clone(),
    );
}

fn format_pg_error(e: &tokio_postgres::Error, sql: &str) -> String {
    let Some(db) = e.as_db_error() else {
        return format!("ERROR: {}", e);
    };

    let msg = db.message();

    let pos_u32: u32 = match db.position() {
        Some(ErrorPosition::Original(p)) => *p,
        Some(ErrorPosition::Internal { position, .. }) => *position,
        None => return format!("ERROR: {}", msg),
    };

    let pos = pos_u32 as usize;

    let mut line = 1usize;
    let mut last_line_start = 0usize;

    for (i, ch) in sql.char_indices() {
        if i >= pos.saturating_sub(1) {
            break;
        }
        if ch == '\n' {
            line += 1;
            last_line_start = i + 1;
        }
    }

    let line_text = sql.lines().nth(line - 1).unwrap_or("");

    let caret_pos = pos.saturating_sub(last_line_start).saturating_sub(1);

    format!(
        "ERROR at Line {}:\nERROR: {}\nLINE {}: {}\n{}^",
        line,
        msg,
        line,
        line_text,
        " ".repeat(caret_pos)
    )
}
