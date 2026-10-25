use std::sync::Arc;
use std::time::Instant;

use futures_util::{pin_mut, StreamExt};
use tauri::Emitter;
use tokio::sync::mpsc;

use crate::engines::cancel::CancelHandle;
use crate::engines::postgres::row_codec;
use crate::operations::ctx::{ActiveGuard, FlowCtrl, FlowGuard, OperationCtx, RunningGuard};
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

/// A cancel ends the operation quietly (`op:done`) only when this app asked
/// for it. SQLSTATE 57014 also covers `statement_timeout` and cancels sent by
/// other sessions; those must surface as errors, never as a complete result.
fn ends_as_user_cancel(query_cancelled: bool, cancel_requested: bool) -> bool {
    query_cancelled && cancel_requested
}

fn cancelled_by_user(ctx: &OperationCtx, err: &tokio_postgres::Error) -> bool {
    ends_as_user_cancel(
        is_cancelled(err),
        ctx.cancel_requested.contains_key(&ctx.op_id),
    )
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

fn is_non_transactional_database_ddl(sql: &str) -> bool {
    let normalized = sql
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase();

    normalized.starts_with("CREATE DATABASE")
        || normalized.starts_with("ALTER DATABASE")
        || normalized.starts_with("DROP DATABASE")
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
    let batch_size: usize = sql_input.batch_size.unwrap_or(100).clamp(1, 2000) as usize;

    let max_rows: u64 = sql_input.max_rows.unwrap_or(1_000_000).clamp(1, 10_000_000) as u64;

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
    // Register cancel handle (token + backend_pid)
    let cancel_token = &client.cancel_token();
    let backend_pid: i32 = match client.query_one("SELECT pg_backend_pid()", &[]).await {
        Ok(row) => row.get::<usize, i32>(0),
        Err(_) => -1,
    };

    ctx.running_ops.insert(
        op_id,
        CancelHandle::Postgres {
            token: cancel_token.clone(),
            backend_pid,
        },
    );

    // Ensure running_ops cleaned once token exists
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));

    // If user requested cancel before token existed, cancel immediately (non-blocking).
    // The request stays recorded (ActiveGuard clears it) so the resulting
    // 57014 is reported as a user cancel.
    if ctx.cancel_requested.contains_key(&op_id) {
        CancelHandle::Postgres {
            token: cancel_token.clone(),
            backend_pid,
        }
        .cancel();
    }

    // CREATE/ALTER/DROP DATABASE are not allowed inside a transaction block.
    // Run them on the raw client path and finish without row streaming.
    if is_non_transactional_database_ddl(&sql_input.sql) {
        if let Err(e) = client.batch_execute(&sql_input.sql).await {
            if cancelled_by_user(&ctx, &e) {
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

            emit_error(
                &ctx.app,
                op_id,
                format_pg_error(&e, &sql_input.sql),
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
            None,
        );
        return;
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

    // Optional read-only: applies to this transaction (must run before any
    // query in it). `default_transaction_read_only` would only affect later ones.
    if sql_input.read_only.unwrap_or(false) {
        if let Err(e) = tx.batch_execute("SET TRANSACTION READ ONLY").await {
            emit_error(
                &ctx.app,
                op_id,
                format_pg_error(&e, &sql_input.sql),
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

    // Optional scoped lock_timeout (diagnostics must not queue behind DDL)
    if let Some(lock_timeout_ms) = sql_input.lock_timeout_ms {
        let lock_timeout_ms = lock_timeout_ms.clamp(10, 60_000);
        if let Err(e) = tx
            .batch_execute(&format!("SET LOCAL lock_timeout = {}", lock_timeout_ms))
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
     * Validation-only path (no chunks, no row fetch)
     * ========================================================================= */
    if validate_only {
        if is_explainable(&sql_input.sql) {
            const EXPLAIN_PREFIX: &str = "EXPLAIN ";
            let explain_sql = format!("{EXPLAIN_PREFIX}{}", sql_input.sql);

            if let Err(e) = tx.batch_execute(&explain_sql).await {
                if cancelled_by_user(&ctx, &e) {
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

                // The position counts the EXPLAIN prefix; point into the
                // statement as written.
                emit_error(
                    &ctx.app,
                    op_id,
                    format_pg_error_after_prefix(&e, &sql_input.sql, EXPLAIN_PREFIX.len() as u32),
                    started_at.elapsed().as_millis(),
                );
                return;
            }
        }

        if let Err(e) = tx.commit().await {
            emit_error(
                &ctx.app,
                op_id,
                format_pg_error(&e, &sql_input.sql),
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

    // FE-ack flow control
    ctx.flow_by_op.insert(op_id, FlowCtrl::new(3));
    let _flow_guard = FlowGuard::new(op_id, Arc::clone(&ctx.flow_by_op));
    let flow = ctx
        .flow_by_op
        .get(&op_id)
        .map(|x| x.clone())
        .expect("FLOW_CTRL_MISSING");

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

    // Query stream
    let stream = match tx.query_raw(&stmt, std::iter::empty::<&str>()).await {
        Ok(s) => s,
        Err(e) => {
            if cancelled_by_user(&ctx, &e) {
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

            let _ = tx_chunk
                .send(Err(format_pg_error(&e, &sql_input.sql)))
                .await;
            drop(tx_chunk);
            let _ = emit_task.await;
            return;
        }
    };

    pin_mut!(stream);

    let mut row_count: u64 = 0;
    let mut row_offset: u64 = 0;
    let mut batch_rows: Vec<Vec<CellValue>> = Vec::with_capacity(batch_size);
    let mut sent_columns = false;

    while let Some(row_result) = stream.next().await {
        let row = match row_result {
            Ok(r) => r,
            Err(e) => {
                if cancelled_by_user(&ctx, &e) {
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

                let _ = tx_chunk
                    .send(Err(format_pg_error(&e, &sql_input.sql)))
                    .await;
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

        if batch_rows.len() >= batch_size {
            // Wait for FE credit (bounded in-flight chunks).
            let permit = flow.acquire_credit().await;
            let seq = flow.alloc_seq().await;

            let chunk = TableChunk {
                op_id,
                seq,
                columns: if !sent_columns {
                    sent_columns = true;
                    done_columns.clone()
                } else {
                    None
                },
                rows: std::mem::take(&mut batch_rows),
                row_offset,
            };
            row_offset = row_count;

            let sent = tx_chunk.send(Ok(chunk)).await;

            if sent.is_err() {
                // Refund credit if send fails to avoid deadlock.
                flow.ack(1);
                drop(tx_chunk);
                let _ = emit_task.await;
                let _ = permit;
                return;
            }

            let _ = permit;
        }
    }

    // Flush remaining
    if !batch_rows.is_empty() {
        let permit = flow.acquire_credit().await;
        let seq = flow.alloc_seq().await;

        let chunk = TableChunk {
            op_id,
            seq,
            columns: if sent_columns {
                None
            } else {
                done_columns.clone()
            },
            rows: batch_rows,
            row_offset,
        };

        let sent = tx_chunk.send(Ok(chunk)).await;
        if sent.is_err() {
            flow.ack(1);
            drop(tx_chunk);
            let _ = emit_task.await;
            let _ = permit;
            return;
        }

        let _ = permit;
    }

    // Commit (ends SET LOCAL scope cleanly)
    if let Err(e) = tx.commit().await {
        let _ = tx_chunk
            .send(Err(format_pg_error(&e, &sql_input.sql)))
            .await;
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
        done_columns,
    );
}

/// Format a tokio-postgres error for the UI.
///
/// `tokio_postgres::Error`'s Display for database errors is the opaque label
/// `"db error"`; the actionable Postgres text lives on the `DbError` source
/// (`message`, `detail`, `hint`). Prefer that (and optional SQL caret) so
/// callers — including Health Inspector — never surface `"ROW_STREAM_FAILED: db error"`.
fn format_pg_error(e: &tokio_postgres::Error, sql: &str) -> String {
    format_pg_error_after_prefix(e, sql, 0)
}

/// `format_pg_error` for an error from `{prefix}{sql}`: the reported position
/// is shifted back by `prefix_len` bytes so the caret points into `sql`.
fn format_pg_error_after_prefix(e: &tokio_postgres::Error, sql: &str, prefix_len: u32) -> String {
    let Some(db) = e.as_db_error() else {
        // Non-db kinds have useful Display labels ("connection closed", …).
        // Include the source when present (e.g. IO cause).
        if let Some(src) = std::error::Error::source(e) {
            return format!("ERROR: {e}: {src}");
        }
        return format!("ERROR: {e}");
    };

    // DbError Display = "{severity}: {message}" + optional DETAIL/HINT.
    annotate_db_error(&db.to_string(), sql, db.position(), prefix_len)
}

/// `core` with a `LINE n:` + caret annotation when the error position points
/// into the statement sent (`{prefix}{sql}`). An internal position counts
/// within an internal query (a function body, …), not the caller's SQL, so it
/// is left unannotated.
fn annotate_db_error(
    core: &str,
    sql: &str,
    position: Option<&ErrorPosition>,
    prefix_len: u32,
) -> String {
    let Some(ErrorPosition::Original(p)) = position else {
        return core.to_string();
    };
    match statement_position(*p, prefix_len) {
        Some(pos) => annotate_sql_error_position(core, sql, pos),
        None => core.to_string(),
    }
}

/// A 1-based position in `{prefix}{sql}` as a 1-based position in `sql`;
/// None when it falls inside the prefix.
fn statement_position(pos: u32, prefix_len: u32) -> Option<u32> {
    pos.checked_sub(prefix_len).filter(|p| *p >= 1)
}

/// Attach `LINE n: …` + caret under `pos`, PostgreSQL's 1-based position in
/// characters (not bytes) into `sql`; the caret indent counts characters too.
fn annotate_sql_error_position(core: &str, sql: &str, pos_u32: u32) -> String {
    let target = (pos_u32 as usize).saturating_sub(1);

    let mut line = 1usize;
    let mut line_start = 0usize;

    for (i, ch) in sql.chars().enumerate() {
        if i >= target {
            break;
        }
        if ch == '\n' {
            line += 1;
            line_start = i + 1;
        }
    }

    let line_text = sql.lines().nth(line - 1).unwrap_or("");
    let caret_pos = target.saturating_sub(line_start);

    format!(
        "ERROR at Line {}:\n{}\nLINE {}: {}\n{}^",
        line,
        core,
        line,
        line_text,
        " ".repeat(caret_pos)
    )
}

#[cfg(test)]
mod tests {
    use super::{
        annotate_db_error, annotate_sql_error_position, ends_as_user_cancel, statement_position,
    };
    use tokio_postgres::error::ErrorPosition;

    #[test]
    fn only_app_requested_cancels_end_quietly() {
        assert!(ends_as_user_cancel(true, true));
        // statement_timeout / another session's pg_cancel_backend
        assert!(!ends_as_user_cancel(true, false));
        assert!(!ends_as_user_cancel(false, true));
        assert!(!ends_as_user_cancel(false, false));
    }

    #[test]
    fn annotate_sql_error_position_points_at_offset() {
        let sql = "SELECT bad_col FROM t";
        // Postgres positions are 1-based; point at 'b' in bad_col (offset 8).
        let out = annotate_sql_error_position("ERROR: column \"bad_col\" does not exist", sql, 8);
        assert!(out.starts_with("ERROR at Line 1:\n"));
        assert!(out.contains("ERROR: column \"bad_col\" does not exist"));
        assert!(out.contains("LINE 1: SELECT bad_col FROM t"));
        assert!(out.ends_with("^") || out.contains("^"));
        // Caret should sit under 'b' of bad_col (7 spaces after "LINE 1: " prefix is separate).
        let caret_line = out.lines().last().unwrap();
        assert_eq!(caret_line.chars().filter(|c| *c == ' ').count(), 7);
    }

    #[test]
    fn statement_position_drops_the_explain_prefix() {
        // "EXPLAIN SELECT bad" — Postgres reports 'b' at 16; in the statement it is 8.
        assert_eq!(statement_position(16, 8), Some(8));
        assert_eq!(statement_position(9, 8), Some(1));
        assert_eq!(statement_position(8, 8), None);
        assert_eq!(statement_position(3, 8), None);
        assert_eq!(statement_position(5, 0), Some(5));
    }

    #[test]
    fn annotate_counts_characters_not_bytes() {
        // 'b' is character 13 of "SELECT 'é', bad" (é is two bytes).
        let out = annotate_sql_error_position("ERROR: x", "SELECT 'é', bad", 13);
        assert!(out.ends_with(&format!("{}^", " ".repeat(12))));
        // Non-ASCII on an earlier line does not move the line or the caret.
        let out = annotate_sql_error_position("ERROR: x", "-- éé\nSELECT bad", 14);
        assert!(out.starts_with("ERROR at Line 2:\n"));
        assert!(out.contains("LINE 2: SELECT bad"));
        assert!(out.ends_with(&format!("{}^", " ".repeat(7))));
    }

    #[test]
    fn only_original_positions_annotate_the_statement() {
        let original = ErrorPosition::Original(16);
        let out = annotate_db_error("ERROR: x", "SELECT bad", Some(&original), 8);
        assert!(out.contains("LINE 1: SELECT bad"));
        assert!(out.ends_with(&format!("{}^", " ".repeat(7))));

        let internal = ErrorPosition::Internal {
            position: 16,
            query: "select bad from t".to_string(),
        };
        assert_eq!(
            annotate_db_error("ERROR: x", "SELECT bad", Some(&internal), 8),
            "ERROR: x"
        );
        assert_eq!(
            annotate_db_error("ERROR: x", "SELECT bad", None, 0),
            "ERROR: x"
        );
    }

    #[test]
    fn annotate_sql_error_position_tracks_newlines() {
        let sql = "SELECT 1\nFROM missing_table";
        // Position at 'm' of missing_table: "SELECT 1\n" = 9 bytes, then FROM + space, m at 1-based 15.
        let out = annotate_sql_error_position(
            "ERROR: relation \"missing_table\" does not exist",
            sql,
            15,
        );
        assert!(out.starts_with("ERROR at Line 2:\n"));
        assert!(out.contains("LINE 2: FROM missing_table"));
    }
}
