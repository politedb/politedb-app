use std::sync::Arc;
use std::time::Instant;

use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::engines::oracle::ensure_oracle_client_initialized;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, SqlQueryInput, TableChunk};

struct OracleQueryResult {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<CellValue>>,
    row_count: u64,
}

fn looks_like_query(sql: &str) -> bool {
    let s = sql.trim_start();
    if s.is_empty() {
        return false;
    }
    let up = s.chars().take(24).collect::<String>().to_uppercase();
    up.starts_with("SELECT") || up.starts_with("WITH")
}

fn oracle_string_to_cell(s: String) -> CellValue {
    let trimmed = s.trim();
    if trimmed.eq_ignore_ascii_case("true") {
        return CellValue::Bool(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return CellValue::Bool(false);
    }
    if let Ok(i) = trimmed.parse::<i64>() {
        return CellValue::I64(i);
    }
    if let Ok(f) = trimmed.parse::<f64>() {
        return CellValue::F64(f);
    }
    CellValue::Str(s)
}

pub async fn run_oracle_sql_query(
    ctx: OperationCtx,
    connect_string: String,
    user: String,
    password: String,
    sql_input: SqlQueryInput,
    _default_statement_timeout_ms: Option<u64>,
) {
    let op_id = ctx.op_id;
    let started_at = Instant::now();

    if let Err(e) = ensure_oracle_client_initialized() {
        emit_error(
            &ctx.app,
            op_id,
            format!("ORACLE_QUERY_FAILED: {e}"),
            started_at.elapsed().as_millis(),
        );
        return;
    }

    let batch_size = sql_input.batch_size.unwrap_or(100).clamp(1, 2000) as usize;
    let max_rows = sql_input.max_rows.unwrap_or(1_000_000).clamp(1, 10_000_000) as usize;
    let validate_only = sql_input.validate_only.unwrap_or(false);

    let _active_guard = ActiveGuard::new(
        op_id,
        Arc::clone(&ctx.active_ops),
        Arc::clone(&ctx.cancel_requested),
    );

    let notify = Arc::new(Notify::new());
    ctx.running_ops.insert(
        op_id,
        CancelHandle::Oracle {
            notify: notify.clone(),
        },
    );
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));
    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    let sql = sql_input.sql.clone();
    let blocking = tokio::task::spawn_blocking(move || -> Result<OracleQueryResult, String> {
        let sql = sql.trim().to_string();
        if sql.is_empty() {
            return Err("ORACLE_SQL_EMPTY".into());
        }

        let conn =
            oracle::Connection::connect(&user, &password, &connect_string).map_err(|e| e.to_string())?;

        if validate_only {
            conn.statement(&sql).build().map_err(|e| e.to_string())?;
            return Ok(OracleQueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
            });
        }

        if looks_like_query(&sql) {
            let mut rs = conn.query(&sql, &[]).map_err(|e| e.to_string())?;
            let columns = rs
                .column_info()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    db_type: c.oracle_type().to_string(),
                })
                .collect::<Vec<_>>();

            let mut rows_out: Vec<Vec<CellValue>> = Vec::new();
            for row_result in &mut rs {
                let row = row_result.map_err(|e| e.to_string())?;
                let mut one = Vec::with_capacity(row.sql_values().len());
                for v in row.sql_values() {
                    let is_null = v.is_null().map_err(|e| e.to_string())?;
                    if is_null {
                        one.push(CellValue::Null);
                    } else {
                        let s = v.to_string();
                        one.push(oracle_string_to_cell(s));
                    }
                }
                rows_out.push(one);
                if rows_out.len() >= max_rows {
                    break;
                }
            }

            return Ok(OracleQueryResult {
                columns,
                row_count: rows_out.len() as u64,
                rows: rows_out,
            });
        }

        let stmt = conn.execute(&sql, &[]).map_err(|e| e.to_string())?;
        let row_count = stmt.row_count().map_err(|e| e.to_string())?;
        Ok(OracleQueryResult {
            columns: vec![],
            rows: vec![],
            row_count,
        })
    });

    let result = match blocking.await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            emit_error(&ctx.app, op_id, format!("ORACLE_QUERY_FAILED: {e}"), started_at.elapsed().as_millis());
            return;
        }
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("ORACLE_QUERY_JOIN_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    if !result.rows.is_empty() {
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
                    "ORACLE_EMIT_CHUNK_FAILED",
                    started_at.elapsed().as_millis(),
                );
                return;
            }
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
