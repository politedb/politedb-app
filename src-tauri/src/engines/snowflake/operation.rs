use std::sync::Arc;
use std::time::Instant;

use snowflake_connector_rs::SnowflakeRow;
use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::engines::snowflake::connection::SnowflakeConn;
use crate::engines::snowflake::driver::create_session;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, SnowflakeConnectInput, SqlQueryInput, TableChunk};

fn looks_like_query(sql: &str) -> bool {
    let s = sql.trim_start();
    if s.is_empty() {
        return false;
    }
    let up = s.chars().take(24).collect::<String>().to_uppercase();
    up.starts_with("SELECT")
        || up.starts_with("WITH")
        || up.starts_with("SHOW")
        || up.starts_with("DESCRIBE")
}

fn snowflake_string_to_cell(s: String) -> CellValue {
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
        if f.is_finite() {
            return CellValue::F64(f);
        }
    }
    CellValue::Str(s)
}

fn row_to_cells(row: &SnowflakeRow) -> Vec<CellValue> {
    let cols = row.column_types();
    let mut cells = Vec::with_capacity(cols.len());
    for col in cols {
        let cell = match row.at::<String>(col.index()) {
            Ok(s) => snowflake_string_to_cell(s),
            Err(_) => CellValue::Null,
        };
        cells.push(cell);
    }
    cells
}

fn columns_from_row(row: &SnowflakeRow) -> Vec<ColumnMeta> {
    row.column_types()
        .into_iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            db_type: format!("{:?}", c.column_type()),
        })
        .collect()
}

fn connect_input_from_conn(conn: &SnowflakeConn) -> SnowflakeConnectInput {
    use crate::types::secret::{SecretRef, SecretRefKind};

    SnowflakeConnectInput {
        account: conn.account.clone(),
        warehouse: conn.warehouse.clone(),
        database: conn.database.clone(),
        schema: Some(conn.schema.clone()),
        role: conn.role.clone(),
        user: conn.user.clone(),
        password: SecretRef {
            kind: SecretRefKind::Inline,
            value: conn.password.clone(),
        },
        connect_timeout_ms: conn.connect_timeout_ms,
        statement_timeout_ms: conn.default_statement_timeout_ms,
    }
}

pub async fn run_snowflake_sql_query(
    ctx: OperationCtx,
    conn: SnowflakeConn,
    sql_input: SqlQueryInput,
    _default_statement_timeout_ms: Option<u64>,
) {
    let op_id = ctx.op_id;
    let started_at = Instant::now();
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
        CancelHandle::Snowflake {
            notify: notify.clone(),
        },
    );
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));
    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    let sql = sql_input.sql.trim().to_string();
    if sql.is_empty() {
        emit_error(
            &ctx.app,
            op_id,
            "SNOWFLAKE_SQL_EMPTY",
            started_at.elapsed().as_millis(),
        );
        return;
    }

    let input = connect_input_from_conn(&conn);
    let password = conn.password.clone();

    let session = match create_session(&input, &password).await {
        Ok(s) => s,
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("SNOWFLAKE_QUERY_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    if validate_only {
        if let Err(e) = session.query(format!("EXPLAIN {sql}")).await {
            emit_error(
                &ctx.app,
                op_id,
                format!("VALIDATION_FAILED: {e}"),
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

    let rows_result = tokio::select! {
        _ = notify.notified() => {
            emit_done(&ctx.app, op_id, false, 0, started_at.elapsed().as_millis(), None);
            return;
        }
        result = session.query(sql.clone()) => result,
    };

    let rows = match rows_result {
        Ok(r) => r,
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("SNOWFLAKE_QUERY_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    if looks_like_query(&sql) {
        let columns = rows.first().map(columns_from_row).unwrap_or_default();
        let mut out_rows: Vec<Vec<CellValue>> = Vec::new();
        for row in rows.iter().take(max_rows) {
            out_rows.push(row_to_cells(row));
        }
        let row_count = out_rows.len() as u64;

        if !out_rows.is_empty() {
            for (i, chunk_rows) in out_rows.chunks(batch_size).enumerate() {
                let chunk = TableChunk {
                    op_id,
                    seq: i as u64,
                    columns: if i == 0 { Some(columns.clone()) } else { None },
                    rows: chunk_rows.to_vec(),
                    row_offset: (i * batch_size) as u64,
                };
                if ctx.app.emit("op:chunk_table", chunk).is_err() {
                    emit_error(
                        &ctx.app,
                        op_id,
                        "SNOWFLAKE_EMIT_CHUNK_FAILED",
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
            row_count,
            started_at.elapsed().as_millis(),
            Some(columns),
        );
        return;
    }

    emit_done(
        &ctx.app,
        op_id,
        false,
        rows.len() as u64,
        started_at.elapsed().as_millis(),
        None,
    );
}
