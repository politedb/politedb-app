use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use klickhouse::block::Block;
use klickhouse::{Type, Value as ChValue};
use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::engines::clickhouse::connection::ClickhouseConn;
use crate::engines::clickhouse::convert::klick_value_to_cell;
use crate::engines::clickhouse::http;
use crate::engines::clickhouse::response::{ChJsonMeta, ChJsonResponse};
use crate::engines::clickhouse::sql::{looks_like_query, split_clickhouse_statements};
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, SqlQueryInput, TableChunk};

fn block_to_matrix(block: &Block) -> (Vec<ChJsonMeta>, Vec<Vec<CellValue>>) {
    let meta: Vec<ChJsonMeta> = block
        .column_types
        .iter()
        .map(|(name, ty): (&String, &Type)| ChJsonMeta {
            name: name.clone(),
            db_type: ty.to_string(),
        })
        .collect();

    let col_names: Vec<&String> = block.column_types.keys().collect();
    let row_count = block.rows as usize;
    let mut matrix = Vec::with_capacity(row_count);

    for i in 0..row_count {
        let row: Vec<CellValue> = col_names
            .iter()
            .map(|name| {
                block
                    .column_data
                    .get(*name)
                    .and_then(|col: &Vec<ChValue>| col.get(i).cloned())
                    .map(|v| {
                        klick_value_to_cell(v, block.column_types.get(*name))
                    })
                    .unwrap_or(CellValue::Null)
            })
            .collect();
        matrix.push(row);
    }

    (meta, matrix)
}

fn merge_block_response(acc: &mut ChJsonResponse, block: &Block) {
    let (meta, rows) = block_to_matrix(block);
    if acc.meta.is_none() && !meta.is_empty() {
        acc.meta = Some(meta);
    }
    let data = acc.data.get_or_insert_with(Vec::new);
    data.extend(rows);
    acc.rows = Some(data.len() as u64);
}

async fn query_native_blocks(
    conn: &ClickhouseConn,
    sql: &str,
    timeout_ms: Option<u64>,
) -> Result<ChJsonResponse, String> {
    use crate::engines::clickhouse::connection::ClickhouseClient;
    use crate::engines::clickhouse::sql::normalize_clickhouse_statement;

    let ClickhouseClient::Native(client) = &conn.client else {
        return Err("CLICKHOUSE_NATIVE_CLIENT_EXPECTED".into());
    };

    let stmt = normalize_clickhouse_statement(sql);
    if stmt.is_empty() {
        return Err("CLICKHOUSE_SQL_EMPTY".into());
    }

    let fut = async {
        let mut stream = client
            .query_raw(&stmt)
            .await
            .map_err(|e| format!("CLICKHOUSE_QUERY_FAILED: {e}"))?;

        let mut response = ChJsonResponse {
            meta: None,
            data: None,
            rows: Some(0),
        };

        while let Some(block) = stream.next().await {
            let block = block.map_err(|e| format!("CLICKHOUSE_QUERY_FAILED: {e}"))?;
            if block.rows > 0 {
                merge_block_response(&mut response, &block);
            }
        }

        Ok(response)
    };

    match timeout_ms {
        Some(ms) => {
            let ms = ms.clamp(100, 300_000);
            tokio::time::timeout(Duration::from_millis(ms), fut)
                .await
                .map_err(|_| format!("CLICKHOUSE_QUERY_TIMEOUT after {ms}ms"))?
        }
        None => fut.await,
    }
}

async fn execute_native(
    conn: &ClickhouseConn,
    sql: &str,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    use crate::engines::clickhouse::connection::ClickhouseClient;
    use crate::engines::clickhouse::sql::normalize_clickhouse_statement;

    let ClickhouseClient::Native(client) = &conn.client else {
        return Err("CLICKHOUSE_NATIVE_CLIENT_EXPECTED".into());
    };

    let stmt = normalize_clickhouse_statement(sql);
    if stmt.is_empty() {
        return Err("CLICKHOUSE_SQL_EMPTY".into());
    }

    let fut = client.execute(&stmt);
    match timeout_ms {
        Some(ms) => {
            let ms = ms.clamp(100, 300_000);
            tokio::time::timeout(Duration::from_millis(ms), fut)
                .await
                .map_err(|_| format!("CLICKHOUSE_QUERY_TIMEOUT after {ms}ms"))?
                .map_err(|e| format!("CLICKHOUSE_QUERY_FAILED: {e}"))
        }
        None => fut
            .await
            .map_err(|e| format!("CLICKHOUSE_QUERY_FAILED: {e}")),
    }
}

async fn execute_clickhouse_batch_native(
    conn: &ClickhouseConn,
    sql: &str,
    timeout_ms: Option<u64>,
) -> Result<ChJsonResponse, String> {
    let statements = split_clickhouse_statements(sql);
    if statements.is_empty() {
        return Err("CLICKHOUSE_SQL_EMPTY".into());
    }

    let mut last_json: Option<ChJsonResponse> = None;

    for (i, stmt) in statements.iter().enumerate() {
        let is_last = i + 1 == statements.len();
        if is_last && looks_like_query(stmt) {
            last_json = Some(query_native_blocks(conn, stmt, timeout_ms).await?);
        } else {
            execute_native(conn, stmt, timeout_ms).await?;
        }
    }

    Ok(last_json.unwrap_or(ChJsonResponse {
        meta: None,
        data: None,
        rows: Some(0),
    }))
}

pub async fn execute_json_query(
    conn: &ClickhouseConn,
    sql: &str,
    timeout_ms: Option<u64>,
) -> Result<ChJsonResponse, String> {
    execute_clickhouse_batch(conn, sql, timeout_ms).await
}

pub async fn execute_clickhouse_batch(
    conn: &ClickhouseConn,
    sql: &str,
    timeout_ms: Option<u64>,
) -> Result<ChJsonResponse, String> {
    if conn.uses_http() {
        http::execute_clickhouse_batch(conn, sql, timeout_ms).await
    } else {
        execute_clickhouse_batch_native(conn, sql, timeout_ms).await
    }
}

pub async fn run_clickhouse_sql_query(
    ctx: OperationCtx,
    conn: ClickhouseConn,
    sql_input: SqlQueryInput,
    default_statement_timeout_ms: Option<u64>,
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
        CancelHandle::Clickhouse {
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
            "CLICKHOUSE_SQL_EMPTY",
            started_at.elapsed().as_millis(),
        );
        return;
    }

    let timeout_ms = sql_input
        .statement_timeout_ms
        .or(default_statement_timeout_ms);

    if validate_only {
        let statements = split_clickhouse_statements(&sql);
        let result = tokio::select! {
            _ = notify.notified() => {
                emit_done(&ctx.app, op_id, false, 0, started_at.elapsed().as_millis(), None);
                return;
            }
            result = async {
                for stmt in &statements {
                    if looks_like_query(stmt) {
                        if conn.uses_http() {
                            http::execute_clickhouse_batch(
                                &conn,
                                &format!("EXPLAIN {stmt}"),
                                timeout_ms,
                            )
                            .await?;
                        } else {
                            query_native_blocks(
                                &conn,
                                &format!("EXPLAIN {stmt}"),
                                timeout_ms,
                            )
                            .await?;
                        }
                    } else if conn.uses_http() {
                        http::execute_clickhouse_batch(&conn, stmt, timeout_ms).await?;
                    } else {
                        execute_native(&conn, stmt, timeout_ms).await?;
                    }
                }
                Ok::<(), String>(())
            } => result,
        };
        if let Err(e) = result {
            emit_error(&ctx.app, op_id, e, started_at.elapsed().as_millis());
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

    let result = tokio::select! {
        _ = notify.notified() => {
            emit_done(&ctx.app, op_id, false, 0, started_at.elapsed().as_millis(), None);
            return;
        }
        result = execute_clickhouse_batch(&conn, &sql, timeout_ms) => result,
    };

    let parsed = match result {
        Ok(v) => v,
        Err(e) => {
            emit_error(&ctx.app, op_id, e, started_at.elapsed().as_millis());
            return;
        }
    };

    let statements = split_clickhouse_statements(&sql);
    let last_stmt = statements
        .last()
        .map(String::as_str)
        .unwrap_or(sql.as_str());
    if !looks_like_query(last_stmt) {
        let affected = parsed.rows.unwrap_or(0);
        emit_done(
            &ctx.app,
            op_id,
            true,
            affected,
            started_at.elapsed().as_millis(),
            None,
        );
        return;
    }

    let meta = parsed.meta.unwrap_or_default();
    let columns: Vec<ColumnMeta> = meta
        .iter()
        .map(|m| ColumnMeta {
            name: m.name.clone(),
            db_type: m.db_type.clone(),
        })
        .collect();

    let mut out_rows: Vec<Vec<CellValue>> = Vec::new();
    if let Some(data) = parsed.data {
        for row in data.into_iter().take(max_rows) {
            out_rows.push(row);
        }
    }

    let row_count = out_rows.len() as u64;
    if out_rows.is_empty() {
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
                "CLICKHOUSE_EMIT_CHUNK_FAILED",
                started_at.elapsed().as_millis(),
            );
            return;
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
}
