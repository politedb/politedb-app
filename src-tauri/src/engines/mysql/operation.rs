use std::sync::Arc;
use std::time::Instant;

use tauri::Emitter;
use tokio::sync::{mpsc, Notify};

use mysql_async::prelude::Queryable;

use crate::engines::cancel::CancelHandle;
use crate::engines::mysql::row_codec;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, SqlQueryInput, TableChunk};

/* =============================================================================
 * Helpers
 * ============================================================================= */

fn is_explainable_mysql(sql: &str) -> bool {
    let s = sql.trim_start();
    if s.is_empty() {
        return false;
    }
    let up = s.chars().take(24).collect::<String>().to_uppercase();
    up.starts_with("SELECT") || up.starts_with("WITH")
}

fn escape_mysql_string_literal(s: &str) -> String {
    // minimal escaping for PREPARE ... FROM '<sql>'
    // escape backslash + single quote
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/* =============================================================================
 * Runner
 * ============================================================================= */

pub async fn run_mysql_sql_query(
    ctx: OperationCtx,
    pool: mysql_async::Pool,
    sql_input: SqlQueryInput,
    default_statement_timeout_ms: Option<u64>,
) {
    let op_id = ctx.op_id;
    let started_at = Instant::now();

    // Ensure active_ops/cancel_requested cleaned even if we fail early
    let _active_guard = ActiveGuard::new(
        op_id,
        Arc::clone(&ctx.active_ops),
        Arc::clone(&ctx.cancel_requested),
    );

    // Batch sizing + limits
    let batch_size = sql_input.batch_size.unwrap_or(200).clamp(1, 2000) as usize;
    let max_rows = sql_input.max_rows.unwrap_or(50_000).clamp(1, 1_000_000) as u64;

    let validate_only = sql_input.validate_only.unwrap_or(false);

    // Cancel handle (best-effort): stop streaming loop
    let notify = Arc::new(Notify::new());
    ctx.running_ops.insert(
        op_id,
        CancelHandle::MySql {
            notify: notify.clone(),
        },
    );

    // Ensure running_ops is cleaned once token exists
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));

    // If cancel was requested before runner registered, cancel immediately
    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    // Get connection
    let mut conn = match pool.get_conn().await {
        Ok(c) => c,
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("MYSQL_GET_CONN_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    // Best-effort session settings
    if sql_input.read_only.unwrap_or(false) {
        let _ = conn.query_drop("SET SESSION TRANSACTION READ ONLY").await;
    }

    let timeout_ms = sql_input
        .statement_timeout_ms
        .or(default_statement_timeout_ms);

    if let Some(ms) = timeout_ms {
        let ms = ms.clamp(100, 300_000);
        let _ = conn
            .query_drop(format!("SET SESSION max_execution_time = {}", ms))
            .await;
    }

    /* =========================================================================
     * ✅ Validation-only path (no chunks, no row fetch)
     * ========================================================================= */
    if validate_only {
        // Best-effort: PREPARE catches parse + some semantic errors without executing.
        // Some DDL may not be prepare-able; for SELECT/WITH we can also EXPLAIN.

        let sql = sql_input.sql.trim().to_string();
        if sql.is_empty() {
            emit_error(
                &ctx.app,
                op_id,
                "VALIDATION_FAILED: SQL_EMPTY".to_string(),
                started_at.elapsed().as_millis(),
            );
            return;
        }

        // Prefer PREPARE when possible
        let escaped = escape_mysql_string_literal(&sql);
        let prep = format!("PREPARE politedb_stmt FROM '{}'", escaped);
        let dealloc = "DEALLOCATE PREPARE politedb_stmt";

        // Try PREPARE
        if let Err(e) = conn.query_drop(prep).await {
            // Fallback: EXPLAIN for SELECT/WITH (still no-execute)
            if is_explainable_mysql(&sql) {
                let explain_sql = format!("EXPLAIN {}", sql);
                if let Err(e2) = conn.query_drop(explain_sql).await {
                    emit_error(
                        &ctx.app,
                        op_id,
                        format!("VALIDATION_FAILED: {e2}"),
                        started_at.elapsed().as_millis(),
                    );
                    return;
                }
            } else {
                emit_error(
                    &ctx.app,
                    op_id,
                    format!("VALIDATION_FAILED: {e}"),
                    started_at.elapsed().as_millis(),
                );
                return;
            }
        } else {
            // Always deallocate if prepared
            let _ = conn.query_drop(dealloc).await;
        }

        // MySQL validation-only: we usually can't get reliable columns without executing.
        // Emit done with columns = None (or Some(empty meta if your type expects Option).
        emit_done(
            &ctx.app,
            op_id,
            false,
            0,
            started_at.elapsed().as_millis(),
            None,
        );
        return;
    }

    /* =========================================================================
     * Execute path (stream rows -> chunk -> done)
     * ========================================================================= */

    // Execute query (iterator-style)
    let mut result = match conn.query_iter(sql_input.sql).await {
        Ok(r) => r,
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("MYSQL_QUERY_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    // Build meta + decoders from columns (do NOT emit meta event anymore)
    let cols = result.columns_ref();
    let (meta, decoders) = row_codec::build_meta_and_decoders_from_columns(cols);

    // ✅ columns shipped in op:done
    let done_columns = Some(meta.clone());

    let (tx_chunk, mut rx_chunk) = mpsc::channel::<Result<TableChunk, String>>(2);

    let app_emit = ctx.app.clone();
    let emit_started_at = started_at;
    let emit_task = tokio::spawn(async move {
        while let Some(item) = rx_chunk.recv().await {
            match item {
                Ok(chunk) => {
                    if app_emit.emit("op:chunk_table", chunk).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    emit_error(&app_emit, op_id, err, emit_started_at.elapsed().as_millis());
                    break;
                }
            }
        }
    });

    let mut row_count: u64 = 0;
    let mut row_offset: u64 = 0;
    let mut batch_rows: Vec<Vec<CellValue>> = Vec::with_capacity(batch_size);

    // Adaptive batching
    let min_batch: usize = 50;
    let max_batch: usize = batch_size;
    let mut target_batch: usize = (batch_size / 2).max(min_batch).min(max_batch);

    loop {
        tokio::select! {
            _ = notify.notified() => {
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

            next = result.next() => {
                let row_opt = match next {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = tx_chunk.send(Err(format!("MYSQL_ROW_STREAM_FAILED: {e}"))).await;
                        drop(tx_chunk);
                        let _ = emit_task.await;
                        return;
                    }
                };

                let Some(row) = row_opt else {
                    break;
                };

                if row_count >= max_rows {
                    break;
                }

                batch_rows.push(row_codec::row_to_cells(&row, &decoders));
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
