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

/// The Explain button sends `SET SHOWPLAN_ALL ON; <statement>; SET
/// SHOWPLAN_ALL OFF;`. SQL Server requires a SET SHOWPLAN statement to be
/// alone in its batch, so this splits it into the SET batch and the
/// statement batch, run in that order on the same connection. The trailing
/// OFF is dropped: the connection is opened for this operation and closed
/// after it. Anything else returns None and runs unchanged.
fn split_showplan(sql: &str) -> Option<(String, String)> {
    let trimmed = sql.trim();
    let upper = trimmed.to_ascii_uppercase();
    let mode = ["ALL", "TEXT", "XML"]
        .into_iter()
        .find(|mode| upper.starts_with(&format!("SET SHOWPLAN_{mode} ON;")))?;
    let on = format!("SET SHOWPLAN_{mode} ON");
    // The prefix matched ASCII, so this index is a char boundary.
    let rest = trimmed.get(on.len() + 1..)?.trim_end();
    let rest = rest.strip_suffix(';').unwrap_or(rest).trim_end();
    let off = format!("SET SHOWPLAN_{mode} OFF");
    // `get` (not indexing): user SQL can end in multi-byte characters, and a
    // cut inside one must mean "no match", never a panic.
    let split = rest.len().checked_sub(off.len())?;
    if !rest.get(split..)?.eq_ignore_ascii_case(&off) {
        return None;
    }
    let statement = rest.get(..split)?.trim_end();
    let statement = statement.strip_suffix(';')?.trim();
    if statement.is_empty() {
        return None;
    }
    Some((on, statement.to_string()))
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

    let batch = match split_showplan(&sql) {
        Some((set_showplan, statement)) => {
            let set = async {
                client
                    .simple_query(set_showplan)
                    .await?
                    .into_results()
                    .await
            };
            if let Err(e) = set.await {
                emit_error(
                    &ctx.app,
                    op_id,
                    format!("SQLSERVER_QUERY_FAILED: {e}"),
                    started_at.elapsed().as_millis(),
                );
                return;
            }
            statement
        }
        None => sql.clone(),
    };

    let mut stream = match client.simple_query(batch).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn showplan_batches_are_split() {
        assert_eq!(
            split_showplan("SET SHOWPLAN_ALL ON;\nselect 1;\nSET SHOWPLAN_ALL OFF;"),
            Some(("SET SHOWPLAN_ALL ON".into(), "select 1".into()))
        );
        // Case, spacing and a missing final semicolon.
        assert_eq!(
            split_showplan("  set showplan_all on;\n select a;b \n;\nset showplan_all off  "),
            Some(("SET SHOWPLAN_ALL ON".into(), "select a;b".into()))
        );
        assert_eq!(
            split_showplan("SET SHOWPLAN_ALL ON;\nselect N'é日';\nSET SHOWPLAN_ALL OFF;"),
            Some(("SET SHOWPLAN_ALL ON".into(), "select N'é日'".into()))
        );
        assert_eq!(
            split_showplan("SET SHOWPLAN_XML ON;\nselect 1;\nSET SHOWPLAN_XML OFF;")
                .map(|(on, _)| on),
            Some("SET SHOWPLAN_XML ON".into())
        );
    }

    #[test]
    fn other_sql_is_left_alone() {
        for sql in [
            "select 1",
            "SET SHOWPLAN_ALL ON",
            "SET SHOWPLAN_ALL ON;\nSET SHOWPLAN_ALL OFF;",
            "SET SHOWPLAN_ALL ON;\nselect 1;\nSET SHOWPLAN_XML OFF;",
            "SET SHOWPLAN_ALL ON;\nselect 1;",
            "SET STATISTICS PROFILE ON;\nselect 1;\nSET STATISTICS PROFILE OFF;",
            // Multi-byte characters where the suffix would start.
            "SET SHOWPLAN_ALL ON; SELECT N'éééééééééé'",
            "SET SHOWPLAN_ALL ON; SELECT N'日本語日本語日本語日本語'",
        ] {
            assert_eq!(split_showplan(sql), None, "{sql}");
        }
    }

    /// Against a disposable SQL Server only:
    /// `SQLSERVER_TEST_PORT=… SQLSERVER_TEST_PASSWORD=… cargo test showplan_live -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn showplan_live() {
        let port: u16 = std::env::var("SQLSERVER_TEST_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let password = std::env::var("SQLSERVER_TEST_PASSWORD").unwrap();
        let mut client = make_client("127.0.0.1", port, "master", "sa", &password, true, None)
            .await
            .unwrap();
        // As one batch, SQL Server refuses it.
        let sql = "SET SHOWPLAN_ALL ON;\nSELECT name FROM sys.objects WHERE object_id > 10 ORDER BY name;\nSET SHOWPLAN_ALL OFF;";
        let whole = async { client.simple_query(sql).await?.into_results().await };
        assert!(whole.await.is_err());

        let mut client = make_client("127.0.0.1", port, "master", "sa", &password, true, None)
            .await
            .unwrap();
        let (on, statement) = split_showplan(sql).unwrap();
        client
            .simple_query(on)
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        let mut stream = client.simple_query(statement).await.unwrap();
        let mut columns = Vec::new();
        let mut rows = Vec::new();
        while let Some(item) = stream.try_next().await.unwrap() {
            match item {
                tiberius::QueryItem::Metadata(meta) => {
                    columns = meta
                        .columns()
                        .iter()
                        .map(|c| c.name().to_string())
                        .collect();
                }
                tiberius::QueryItem::Row(row) => {
                    rows.push(row.cells().map(|(_, v)| col_to_cell(v)).collect::<Vec<_>>());
                }
            }
        }
        // A plan, not the statement's rows.
        for name in [
            "NodeId",
            "Parent",
            "PhysicalOp",
            "StmtText",
            "TotalSubtreeCost",
        ] {
            assert!(columns.iter().any(|c| c == name), "{name} in {columns:?}");
        }
        assert!(rows.len() >= 2);
        if let Ok(path) = std::env::var("SQLSERVER_TEST_DUMP") {
            std::fs::write(
                path,
                serde_json::to_string(&serde_json::json!({ "columns": columns, "rows": rows }))
                    .unwrap(),
            )
            .unwrap();
        }
    }
}
