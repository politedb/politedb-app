use std::sync::Arc;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::types::ValueRef;
use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, SqlQueryInput, TableChunk};

struct SqliteQueryResult {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<CellValue>>,
    row_count: u64,
}

fn sqlite_value_to_cell(v: ValueRef<'_>) -> CellValue {
    match v {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(i) => CellValue::I64(i),
        ValueRef::Real(f) => CellValue::F64(f),
        ValueRef::Text(t) => CellValue::Str(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => CellValue::BytesB64(STANDARD.encode(b)),
    }
}

pub async fn run_sqlite_sql_query(
    ctx: OperationCtx,
    db_path: String,
    sql_input: SqlQueryInput,
    _default_statement_timeout_ms: Option<u64>,
) {
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
        CancelHandle::Sqlite {
            notify: notify.clone(),
        },
    );
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));

    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    let sql = sql_input.sql.clone();
    let blocking = tokio::task::spawn_blocking(move || -> Result<SqliteQueryResult, String> {
        let sql = sql.trim().to_string();
        if sql.is_empty() {
            return Err("SQLITE_SQL_EMPTY".into());
        }

        let conn =
            rusqlite::Connection::open(&db_path).map_err(|e| format!("SQLITE_OPEN_FAILED: {e}"))?;

        if validate_only {
            let stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("SQLITE_VALIDATE_FAILED: {e}"))?;
            let col_count = stmt.column_count();
            let mut columns = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let name = stmt.column_name(i).unwrap_or("").to_string();
                columns.push(ColumnMeta {
                    name,
                    db_type: "".into(),
                });
            }

            return Ok(SqliteQueryResult {
                columns,
                rows: vec![],
                row_count: 0,
            });
        }

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("SQLITE_PREPARE_FAILED: {e}"))?;

        let col_count = stmt.column_count();
        let mut columns = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let name = stmt.column_name(i).unwrap_or("").to_string();
            columns.push(ColumnMeta {
                name,
                db_type: "".into(),
            });
        }

        // Statements without result set (INSERT/UPDATE/DELETE/DDL).
        if col_count == 0 {
            let affected = stmt
                .execute([])
                .map_err(|e| format!("SQLITE_EXECUTE_FAILED: {e}"))?;

            return Ok(SqliteQueryResult {
                columns,
                rows: vec![],
                row_count: affected as u64,
            });
        }

        let mut rows = stmt
            .query([])
            .map_err(|e| format!("SQLITE_QUERY_FAILED: {e}"))?;

        let mut out = Vec::<Vec<CellValue>>::new();
        while let Some(row) = rows
            .next()
            .map_err(|e| format!("SQLITE_ROW_STREAM_FAILED: {e}"))?
        {
            if out.len() >= max_rows {
                break;
            }

            let mut one = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let v = row
                    .get_ref(i)
                    .map_err(|e| format!("SQLITE_ROW_DECODE_FAILED: {e}"))?;
                one.push(sqlite_value_to_cell(v));
            }
            out.push(one);
        }

        Ok(SqliteQueryResult {
            columns,
            row_count: out.len() as u64,
            rows: out,
        })
    });

    let result = match blocking.await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            emit_error(&ctx.app, op_id, e, started_at.elapsed().as_millis());
            return;
        }
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("SQLITE_QUERY_JOIN_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
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
                "SQLITE_EMIT_CHUNK_FAILED",
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
