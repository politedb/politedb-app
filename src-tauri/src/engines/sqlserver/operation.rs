use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use tauri::Emitter;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, SqlQueryInput, TableChunk};

fn looks_like_query(sql: &str) -> bool {
    let s = sql.trim_start();
    if s.is_empty() {
        return false;
    }
    let up = s.to_uppercase();
    up.starts_with("SELECT")
        || up.starts_with("WITH")
        || up.starts_with("EXPLAIN")
        || up.starts_with("SET SHOWPLAN")
        || up.starts_with("SET STATISTICS")
}

fn col_to_cell(v: &tiberius::ColumnData<'static>) -> CellValue {
    match v {
        tiberius::ColumnData::U8(Some(x)) => CellValue::I64(*x as i64),
        tiberius::ColumnData::I16(Some(x)) => CellValue::I64(*x as i64),
        tiberius::ColumnData::I32(Some(x)) => CellValue::I64(*x as i64),
        tiberius::ColumnData::I64(Some(x)) => CellValue::I64(*x),
        tiberius::ColumnData::F32(Some(x)) => CellValue::F64(*x as f64),
        tiberius::ColumnData::F64(Some(x)) => CellValue::F64(*x),
        tiberius::ColumnData::Bit(Some(x)) => CellValue::Bool(*x),
        tiberius::ColumnData::String(Some(x)) => CellValue::Str(x.to_string()),
        tiberius::ColumnData::Guid(Some(x)) => CellValue::Str(x.to_string()),
        tiberius::ColumnData::Binary(Some(x)) => CellValue::Str(format!("{:?}", x.as_ref())),
        tiberius::ColumnData::Numeric(Some(x)) => CellValue::Str(x.to_string()),
        tiberius::ColumnData::Xml(Some(x)) => CellValue::Str(format!("{x:?}")),
        tiberius::ColumnData::DateTime(Some(x)) => CellValue::Str(format!("{x:?}")),
        tiberius::ColumnData::SmallDateTime(Some(x)) => CellValue::Str(format!("{x:?}")),
        tiberius::ColumnData::Time(Some(x)) => CellValue::Str(format!("{x:?}")),
        tiberius::ColumnData::Date(Some(x)) => CellValue::Str(format!("{x:?}")),
        tiberius::ColumnData::DateTime2(Some(x)) => CellValue::Str(format!("{x:?}")),
        tiberius::ColumnData::DateTimeOffset(Some(x)) => CellValue::Str(format!("{x:?}")),
        _ => CellValue::Null,
    }
}

pub(crate) async fn make_client(
    host: &str,
    port: u16,
    database: &str,
    user: &str,
    password: &str,
    encrypt: bool,
    connect_timeout_ms: Option<u64>,
) -> Result<tiberius::Client<tokio_util::compat::Compat<TcpStream>>, String> {
    let mut config = tiberius::Config::new();
    config.host(host);
    config.port(port);
    config.database(database);
    config.authentication(tiberius::AuthMethod::sql_server(user, password));
    if encrypt {
        config.encryption(tiberius::EncryptionLevel::Required);
        config.trust_cert();
    } else {
        config.encryption(tiberius::EncryptionLevel::NotSupported);
    }
    let connect_timeout =
        Duration::from_millis(connect_timeout_ms.unwrap_or(15_000).clamp(100, 300_000));

    let addr = config.get_addr();
    let tcp = tokio::time::timeout(connect_timeout, TcpStream::connect(addr))
        .await
        .map_err(|_| "SQLSERVER_TCP_CONNECT_TIMEOUT".to_string())?
        .map_err(|e| format!("SQLSERVER_TCP_CONNECT_FAILED: {e}"))?;
    tcp.set_nodelay(true)
        .map_err(|e| format!("SQLSERVER_TCP_NODELAY_FAILED: {e}"))?;
    tokio::time::timeout(
        connect_timeout,
        tiberius::Client::connect(config, tcp.compat_write()),
    )
    .await
    .map_err(|_| "SQLSERVER_CLIENT_CONNECT_TIMEOUT".to_string())?
    .map_err(|e| format!("SQLSERVER_CLIENT_CONNECT_FAILED: {e}"))
}

#[allow(clippy::too_many_arguments)]
pub async fn run_sqlserver_sql_query(
    ctx: OperationCtx,
    host: String,
    port: u16,
    database: String,
    user: String,
    password: String,
    encrypt: bool,
    connect_timeout_ms: Option<u64>,
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
        CancelHandle::SqlServer {
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
            "SQLSERVER_SQL_EMPTY",
            started_at.elapsed().as_millis(),
        );
        return;
    }

    let mut client = match make_client(
        &host,
        port,
        &database,
        &user,
        &password,
        encrypt,
        connect_timeout_ms,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("SQLSERVER_QUERY_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    if validate_only {
        let wrapped = format!("SET PARSEONLY ON; {sql}; SET PARSEONLY OFF;");
        if let Err(e) = client.simple_query(wrapped).await {
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

    let mut stream = match client.simple_query(sql.clone()).await {
        Ok(s) => s,
        Err(e) => {
            emit_error(
                &ctx.app,
                op_id,
                format!("SQLSERVER_QUERY_FAILED: {e}"),
                started_at.elapsed().as_millis(),
            );
            return;
        }
    };

    let mut columns: Vec<ColumnMeta> = Vec::new();
    let mut rows: Vec<Vec<CellValue>> = Vec::new();
    let mut row_count: u64 = 0;

    loop {
        tokio::select! {
            _ = notify.notified() => {
                emit_done(&ctx.app, op_id, false, row_count, started_at.elapsed().as_millis(), Some(columns));
                return;
            }
            item = stream.try_next() => {
                let Some(item) = (match item {
                    Ok(x) => x,
                    Err(e) => {
                        emit_error(
                            &ctx.app,
                            op_id,
                            format!("SQLSERVER_ROW_STREAM_FAILED: {e}"),
                            started_at.elapsed().as_millis(),
                        );
                        return;
                    }
                }) else { break; };

                match item {
                    tiberius::QueryItem::Metadata(meta) => {
                        columns = meta
                            .columns()
                            .iter()
                            .map(|c| ColumnMeta {
                                name: c.name().to_string(),
                                db_type: format!("{:?}", c.column_type()),
                            })
                            .collect();
                    }
                    tiberius::QueryItem::Row(row) => {
                        if looks_like_query(&sql) {
                            let mut one = Vec::with_capacity(row.len());
                            for (_, v) in row.cells() {
                                one.push(col_to_cell(v));
                            }
                            rows.push(one);
                            row_count += 1;
                            if rows.len() >= max_rows {
                                break;
                            }
                        } else {
                            row_count += 1;
                        }
                    }
                }
            }
        }
    }

    if !rows.is_empty() {
        for (i, chunk_rows) in rows.chunks(batch_size).enumerate() {
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
                    "SQLSERVER_EMIT_CHUNK_FAILED",
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
}
