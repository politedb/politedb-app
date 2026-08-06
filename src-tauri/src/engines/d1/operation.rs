use std::sync::Arc;
use std::time::Instant;

use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::engines::d1::api::execute_d1_query;
use crate::engines::d1::connection::D1Conn;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{SqlQueryInput, TableChunk};

pub async fn run_d1_sql_query(ctx: OperationCtx, conn: D1Conn, sql_input: SqlQueryInput) {
    let op_id = ctx.op_id;
    let started_at = Instant::now();

    let _active_guard = ActiveGuard::new(
        op_id,
        Arc::clone(&ctx.active_ops),
        Arc::clone(&ctx.cancel_requested),
    );

    let batch_size = sql_input.batch_size.unwrap_or(100).clamp(1, 2000) as usize;
    let max_rows = sql_input.max_rows.unwrap_or(1_000_000).clamp(1, 10_000_000) as usize;
    let validate_only = sql_input.validate_only.unwrap_or(false);

    let notify = Arc::new(Notify::new());
    ctx.running_ops.insert(
        op_id,
        CancelHandle::D1 {
            notify: notify.clone(),
        },
    );
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));

    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    let sql = sql_input.sql.trim().to_string();
    if validate_only {
        if sql.is_empty() {
            emit_error(
                &ctx.app,
                op_id,
                "D1_SQL_EMPTY",
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
            Some(vec![]),
        );
        return;
    }

    let http = conn.http.clone();
    let api_base = conn.api_base.clone();
    let account_id = conn.account_id.clone();
    let database_id = conn.database_id.clone();
    let api_token = conn.api_token.clone();

    let timeout_ms = sql_input
        .statement_timeout_ms
        .or(conn.default_statement_timeout_ms)
        .map(|ms| ms.clamp(100, 300_000));

    let query_fut = execute_d1_query(
        &http,
        &api_base,
        &account_id,
        &database_id,
        &api_token,
        &sql,
    );

    let result = match timeout_ms {
        Some(ms) => {
            match tokio::time::timeout(std::time::Duration::from_millis(ms), query_fut).await {
                Ok(r) => r,
                Err(_) => Err("D1_QUERY_TIMEOUT".into()),
            }
        }
        None => query_fut.await,
    };

    let result = match result {
        Ok(v) => v,
        Err(e) => {
            emit_error(&ctx.app, op_id, e, started_at.elapsed().as_millis());
            return;
        }
    };

    let mut rows = result.rows;
    if rows.len() > max_rows {
        rows.truncate(max_rows);
    }

    for (i, chunk_rows) in rows.chunks(batch_size).enumerate() {
        let chunk = TableChunk {
            op_id,
            seq: i as u64,
            columns: if i == 0 {
                Some(result.columns.clone())
            } else {
                None
            },
            rows: chunk_rows.to_vec(),
            row_offset: (i * batch_size) as u64,
        };

        if ctx.app.emit("op:chunk_table", chunk).is_err() {
            emit_error(
                &ctx.app,
                op_id,
                "D1_EMIT_CHUNK_FAILED",
                started_at.elapsed().as_millis(),
            );
            return;
        }
    }

    emit_done(
        &ctx.app,
        op_id,
        false,
        result.row_count,
        started_at.elapsed().as_millis(),
        Some(result.columns),
    );
}
