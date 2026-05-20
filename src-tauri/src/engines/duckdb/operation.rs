use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use duckdb::types::{FromSql, ValueRef};
use duckdb::{Connection, Rows};
use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::engines::duckdb::util::with_duckdb_connection;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, SqlQueryInput, TableChunk};

struct DuckdbQueryResult {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<CellValue>>,
    row_count: u64,
}

fn columns_from_rows(rows: &Rows<'_>) -> Result<Vec<ColumnMeta>, String> {
    let stmt = rows
        .as_ref()
        .ok_or_else(|| "DUCKDB_ROWS_STMT_MISSING".to_string())?;
    let col_count = stmt.column_count();
    let mut columns = Vec::with_capacity(col_count);
    for i in 0..col_count {
        let name = stmt
            .column_name(i)
            .map_err(|e| format!("DUCKDB_COLUMN_NAME_FAILED: {e}"))?
            .to_string();
        columns.push(ColumnMeta {
            name,
            db_type: "".into(),
        });
    }
    Ok(columns)
}

fn format_naive_datetime(dt: NaiveDateTime) -> String {
    if dt.nanosecond() > 0 {
        dt.format("%Y-%m-%d %H:%M:%S%.f").to_string()
    } else {
        dt.format("%Y-%m-%d %H:%M:%S").to_string()
    }
}

fn format_naive_time(t: NaiveTime) -> String {
    if t.nanosecond() > 0 {
        t.format("%H:%M:%S%.f").to_string()
    } else {
        t.format("%H:%M:%S").to_string()
    }
}

fn duckdb_temporal_to_string(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Date32(_) => NaiveDate::column_result(v)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|_| format!("{v:?}")),
        ValueRef::Time64(_, _) => NaiveTime::column_result(v)
            .map(format_naive_time)
            .unwrap_or_else(|_| format!("{v:?}")),
        ValueRef::Timestamp(_, _) => NaiveDateTime::column_result(v)
            .map(format_naive_datetime)
            .unwrap_or_else(|_| format!("{v:?}")),
        _ => format!("{v:?}"),
    }
}

fn duckdb_value_to_cell(v: ValueRef<'_>) -> CellValue {
    match v {
        ValueRef::Null => CellValue::Null,
        ValueRef::Boolean(b) => CellValue::Bool(b),
        ValueRef::TinyInt(i) => CellValue::I64(i as i64),
        ValueRef::SmallInt(i) => CellValue::I64(i as i64),
        ValueRef::Int(i) => CellValue::I64(i as i64),
        ValueRef::BigInt(i) => CellValue::I64(i),
        ValueRef::HugeInt(i) => CellValue::I64(i as i64),
        ValueRef::UTinyInt(i) => CellValue::I64(i as i64),
        ValueRef::USmallInt(i) => CellValue::I64(i as i64),
        ValueRef::UInt(i) => CellValue::I64(i as i64),
        ValueRef::UBigInt(i) => CellValue::I64(i as i64),
        ValueRef::Float(f) => CellValue::F64(f as f64),
        ValueRef::Double(f) => CellValue::F64(f),
        ValueRef::Decimal(d) => CellValue::Str(d.to_string()),
        ValueRef::Timestamp(_, _) | ValueRef::Date32(_) | ValueRef::Time64(_, _) => {
            CellValue::Str(duckdb_temporal_to_string(v))
        }
        ValueRef::Text(t) => CellValue::Str(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => CellValue::BytesB64(STANDARD.encode(b)),
        ValueRef::Interval {
            months,
            days,
            nanos,
        } => CellValue::Str(format!("{months}mo {days}d {nanos}ns")),
        _ => CellValue::Str(format!("{v:?}")),
    }
}

pub async fn run_duckdb_sql_query(
    ctx: OperationCtx,
    shared: Arc<Mutex<Connection>>,
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
        CancelHandle::Duckdb {
            notify: notify.clone(),
        },
    );
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));

    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    let sql = sql_input.sql.clone();
    let blocking = tokio::task::spawn_blocking(move || -> Result<DuckdbQueryResult, String> {
        let sql = sql.trim().to_string();
        if sql.is_empty() {
            return Err("DUCKDB_SQL_EMPTY".into());
        }

        if validate_only {
            return with_duckdb_connection(&shared, |conn| {
                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| format!("DUCKDB_VALIDATE_FAILED: {e}"))?;
                match stmt.query([]) {
                    Ok(rows) => {
                        let columns = columns_from_rows(&rows)?;
                        Ok(DuckdbQueryResult {
                            columns,
                            rows: vec![],
                            row_count: 0,
                        })
                    }
                    Err(_) => {
                        let mut stmt = conn
                            .prepare(&sql)
                            .map_err(|e| format!("DUCKDB_VALIDATE_FAILED: {e}"))?;
                        stmt.execute([])
                            .map_err(|e| format!("DUCKDB_VALIDATE_FAILED: {e}"))?;
                        Ok(DuckdbQueryResult {
                            columns: vec![],
                            rows: vec![],
                            row_count: 0,
                        })
                    }
                }
            });
        }

        with_duckdb_connection(&shared, |conn| {
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("DUCKDB_PREPARE_FAILED: {e}"))?;

            match stmt.query([]) {
                Ok(mut rows) => {
                    let columns = columns_from_rows(&rows)?;
                    let col_count = columns.len();
                    let mut out = Vec::<Vec<CellValue>>::new();
                    while let Some(row) = rows
                        .next()
                        .map_err(|e| format!("DUCKDB_ROW_STREAM_FAILED: {e}"))?
                    {
                        if out.len() >= max_rows {
                            break;
                        }
                        let mut one = Vec::with_capacity(col_count);
                        for i in 0..col_count {
                            let v = row
                                .get_ref(i)
                                .map_err(|e| format!("DUCKDB_ROW_DECODE_FAILED: {e}"))?;
                            one.push(duckdb_value_to_cell(v));
                        }
                        out.push(one);
                    }

                    Ok(DuckdbQueryResult {
                        columns,
                        row_count: out.len() as u64,
                        rows: out,
                    })
                }
                Err(_) => {
                    let mut stmt = conn
                        .prepare(&sql)
                        .map_err(|e| format!("DUCKDB_PREPARE_FAILED: {e}"))?;
                    let affected = stmt
                        .execute([])
                        .map_err(|e| format!("DUCKDB_EXECUTE_FAILED: {e}"))?;
                    Ok(DuckdbQueryResult {
                        columns: vec![],
                        rows: vec![],
                        row_count: affected as u64,
                    })
                }
            }
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
                format!("DUCKDB_QUERY_JOIN_FAILED: {e}"),
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
                "DUCKDB_EMIT_CHUNK_FAILED",
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
