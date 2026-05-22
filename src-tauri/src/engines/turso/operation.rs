use std::time::Instant;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use libsql::Value;
use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::engines::turso::connection::TursoConn;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, SqlQueryInput, TableChunk};

struct TursoQueryResult {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<CellValue>>,
    row_count: u64,
}

fn turso_value_to_cell(v: Value) -> CellValue {
    match v {
        Value::Null => CellValue::Null,
        Value::Integer(i) => CellValue::I64(i),
        Value::Real(f) => CellValue::F64(f),
        Value::Text(t) => CellValue::Str(t),
        Value::Blob(b) => CellValue::BytesB64(STANDARD.encode(b)),
    }
}

async fn execute_turso_sql(
    conn: &TursoConn,
    sql: &str,
    validate_only: bool,
    max_rows: usize,
) -> Result<TursoQueryResult, String> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err("TURSO_SQL_EMPTY".into());
    }

    let libsql_conn = conn
        .db
        .connect()
        .map_err(|e| format!("TURSO_CONN_OPEN_FAILED: {e}"))?;

    let stmt = libsql_conn
        .prepare(sql)
        .await
        .map_err(|e| format!("TURSO_PREPARE_FAILED: {e}"))?;

    let cols = stmt.columns();
    let columns = cols
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            db_type: c.decl_type().unwrap_or("").to_string(),
        })
        .collect::<Vec<_>>();

    if validate_only {
        return Ok(TursoQueryResult {
            columns,
            rows: vec![],
            row_count: 0,
        });
    }

    if columns.is_empty() {
        let affected = stmt
            .execute(())
            .await
            .map_err(|e| format!("TURSO_EXECUTE_FAILED: {e}"))?;

        return Ok(TursoQueryResult {
            columns,
            rows: vec![],
            row_count: affected as u64,
        });
    }

    let mut rows_stream = stmt
        .query(())
        .await
        .map_err(|e| format!("TURSO_QUERY_FAILED: {e}"))?;

    let col_count = rows_stream.column_count();
    let mut out = Vec::<Vec<CellValue>>::new();

    while let Some(row) = rows_stream
        .next()
        .await
        .map_err(|e| format!("TURSO_ROW_STREAM_FAILED: {e}"))?
    {
        if out.len() >= max_rows {
            break;
        }

        let mut one = Vec::with_capacity(col_count as usize);
        for i in 0..col_count {
            let v = row
                .get_value(i)
                .map_err(|e| format!("TURSO_ROW_DECODE_FAILED: {e}"))?;
            one.push(turso_value_to_cell(v));
        }
        out.push(one);
    }

    Ok(TursoQueryResult {
        row_count: out.len() as u64,
        columns,
        rows: out,
    })
}

pub async fn run_turso_sql_query(ctx: OperationCtx, conn: TursoConn, sql_input: SqlQueryInput) {
    let op_id = ctx.op_id;
    let started_at = Instant::now();

    let _active_guard = ActiveGuard::new(
        op_id,
        std::sync::Arc::clone(&ctx.active_ops),
        std::sync::Arc::clone(&ctx.cancel_requested),
    );

    let batch_size = sql_input.batch_size.unwrap_or(100).clamp(1, 2000) as usize;
    let max_rows = sql_input.max_rows.unwrap_or(1_000_000).clamp(1, 10_000_000) as usize;
    let validate_only = sql_input.validate_only.unwrap_or(false);

    let notify = std::sync::Arc::new(Notify::new());
    ctx.running_ops.insert(
        op_id,
        CancelHandle::Turso {
            notify: notify.clone(),
        },
    );
    let _running_guard = RunningGuard::new(op_id, std::sync::Arc::clone(&ctx.running_ops));

    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    let sql = sql_input.sql.trim().to_string();
    let timeout_ms = sql_input
        .statement_timeout_ms
        .or(conn.default_statement_timeout_ms)
        .map(|ms| ms.clamp(100, 300_000));

    let query_fut = execute_turso_sql(&conn, &sql, validate_only, max_rows);

    let result = match timeout_ms {
        Some(ms) => {
            match tokio::time::timeout(std::time::Duration::from_millis(ms), query_fut).await {
                Ok(r) => r,
                Err(_) => Err("TURSO_QUERY_TIMEOUT".into()),
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

    for (i, chunk_rows) in result.rows.chunks(batch_size).enumerate() {
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
                "TURSO_EMIT_CHUNK_FAILED",
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

pub async fn execute_turso_statements(
    conn: &TursoConn,
    statements: &[String],
) -> Result<(), String> {
    let libsql_conn = conn
        .db
        .connect()
        .map_err(|e| format!("TURSO_CONN_OPEN_FAILED: {e}"))?;

    let tx = libsql_conn
        .transaction()
        .await
        .map_err(|e| format!("TURSO_TX_BEGIN_FAILED: {e}"))?;

    for (idx, stmt) in statements.iter().enumerate() {
        if let Err(e) = tx.execute(stmt, ()).await {
            let _ = tx.rollback().await;
            return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
        }
    }

    tx.commit()
        .await
        .map_err(|e| format!("TURSO_TX_COMMIT_FAILED: {e}"))?;

    Ok(())
}
