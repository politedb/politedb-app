use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use deadpool_redis::Pool;
use redis::AsyncCommands;
use tauri::Emitter;
use tokio::sync::{mpsc, Notify};
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error, emit_meta};
use crate::types::{CellValue, ColumnMeta, RedisCommandInput, TableChunk};

/* =============================================================================
 * Decode helpers (engine-stable)
 * ============================================================================= */

fn bytes_to_cell(b: Vec<u8>) -> CellValue {
    // UTF-8 best-effort, fallback base64
    match String::from_utf8(b.clone()) {
        Ok(s) => CellValue::Str(s),
        Err(_) => CellValue::BytesB64(base64::engine::general_purpose::STANDARD.encode(b)),
    }
}

fn value_to_cell(v: redis::Value) -> CellValue {
    use redis::Value;

    match v {
        Value::Nil => CellValue::Null,
        Value::Int(i) => CellValue::I64(i),
        Value::Double(f) => CellValue::F64(f),
        Value::Boolean(b) => CellValue::Bool(b),

        // RESP2 bulk string / RESP3 bulk string
        Value::BulkString(b) => bytes_to_cell(b),

        // RESP3 simple string
        Value::SimpleString(s) => CellValue::Str(s),

        // "OK"
        Value::Okay => CellValue::Str("OK".to_string()),

        // Arrays / Sets => JSON-ish string (giữ FE stable)
        Value::Array(items) | Value::Set(items) => {
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                out.push(cell_to_string(value_to_cell(it)));
            }
            CellValue::Json(format!("[{}]", out.join(",")))
        }

        // Map / Attribute / Push => JSON-ish string (best-effort)
        Value::Map(pairs) => {
            let mut out = Vec::with_capacity(pairs.len());
            for (k, val) in pairs {
                let kk = cell_to_string(value_to_cell(k));
                let vv = cell_to_string(value_to_cell(val));
                out.push(format!("{kk}:{vv}"));
            }
            CellValue::Json(format!("{{{}}}", out.join(",")))
        }

        Value::Attribute { data, attributes } => {
            // gói lại cho FE: {"data":..., "attr":{...}}
            let data_s = cell_to_string(value_to_cell(*data));
            let mut out = Vec::with_capacity(attributes.len());
            for (k, val) in attributes {
                let kk = cell_to_string(value_to_cell(k));
                let vv = cell_to_string(value_to_cell(val));
                out.push(format!("{kk}:{vv}"));
            }
            CellValue::Json(format!(
                "{{\"data\":{data_s},\"attr\":{{{}}}}}",
                out.join(",")
            ))
        }

        Value::Push { kind: _, data } => {
            let mut out = Vec::with_capacity(data.len());
            for it in data {
                out.push(cell_to_string(value_to_cell(it)));
            }
            CellValue::Json(format!("[{}]", out.join(",")))
        }

        Value::VerbatimString { format: _, text } => CellValue::Str(text),

        // ServerError => string (ServerError doesn't implement Display)
        Value::ServerError(e) => CellValue::Str(format!("{e:?}")),

        // BigNumber (feature-gated) => string
        Value::BigNumber(x) => CellValue::Str(format!("{x:?}")),
    }
}

// helper cho JSON-ish string
fn cell_to_string(c: CellValue) -> String {
    match c {
        CellValue::Null => "null".into(),
        CellValue::Bool(b) => if b { "true" } else { "false" }.into(),
        CellValue::I64(i) => i.to_string(),
        CellValue::F64(f) => f.to_string(),
        CellValue::Str(s) => format!("{:?}", s), // quote string
        CellValue::Json(s) => s,                 // assume already json-ish
        CellValue::BytesB64(s) => format!("{:?}", s), // quote
    }
}
/* =============================================================================
 * Emit helpers
 * ============================================================================= */

async fn emit_table_chunks(
    app: tauri::AppHandle,
    op_id: Uuid,
    mut rx_chunk: mpsc::Receiver<Result<TableChunk, String>>,
) {
    while let Some(item) = rx_chunk.recv().await {
        match item {
            Ok(chunk) => {
                let _ = app.emit("op:chunk_table", chunk);
            }
            Err(err) => {
                let _ = app.emit(
                    "op:error",
                    crate::types::OperationError { op_id, error: err },
                );
                break;
            }
        }
    }
}

/* =============================================================================
 * Runner
 * ============================================================================= */

pub async fn run_redis_command(
    ctx: OperationCtx,
    pool: Pool,
    default_command_timeout_ms: Option<u64>,
    input: RedisCommandInput,
) {
    let op_id = ctx.op_id;

    // Ensure active_ops/cancel_requested cleaned even if we fail early
    let _active_guard = ActiveGuard::new(
        op_id,
        Arc::clone(&ctx.active_ops),
        Arc::clone(&ctx.cancel_requested),
    );

    let batch_size = input.batch_size.unwrap_or(200).clamp(1, 2000) as usize;
    let max_rows = input.max_rows.unwrap_or(50_000).clamp(1, 1_000_000);

    // Cancel handle (best-effort): stop loop / stop long scan
    let notify = Arc::new(Notify::new());
    ctx.running_ops.insert(
        op_id,
        CancelHandle::Redis {
            notify: notify.clone(),
        },
    );
    let _running_guard = RunningGuard::new(op_id, Arc::clone(&ctx.running_ops));

    // If cancel requested before runner registered
    if ctx.cancel_requested.remove(&op_id).is_some() {
        notify.notify_waiters();
    }

    // Resolve timeout: op override -> conn default
    let timeout_ms = input.command_timeout_ms.or(default_command_timeout_ms);
    let timeout = timeout_ms.map(|ms| Duration::from_millis(ms.clamp(50, 300_000)));

    // Backpressure channel (inflight chunks)
    let (tx_chunk, rx_chunk) = mpsc::channel::<Result<TableChunk, String>>(2);
    let app_emit = ctx.app.clone();
    let emit_task = tokio::spawn(emit_table_chunks(app_emit, op_id, rx_chunk));

    // Get redis connection
    let mut conn = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            emit_error(&ctx.app, op_id, format!("REDIS_GET_CONN_FAILED: {e}"));
            return;
        }
    };

    let cmd = input.cmd.trim().to_uppercase();

    // ----------------------------
    // Command-specific table shapes
    // ----------------------------

    // Default: 2 cols (idx, value) for multi/arrays, or 1 row 1 col for scalar.
    // Meta is ALWAYS emitted.
    // NOTE: FE should render ColumnMeta consistently across engines.
    match cmd.as_str() {
        "GET" => {
            emit_meta(
                &ctx.app,
                op_id,
                vec![
                    ColumnMeta {
                        name: "key".into(),
                        db_type: "redis:string".into(),
                    },
                    ColumnMeta {
                        name: "value".into(),
                        db_type: "redis:value".into(),
                    },
                ],
            );

            let key = input.args.get(0).cloned().unwrap_or_default();
            if key.is_empty() {
                emit_error(&ctx.app, op_id, "REDIS_KEY_REQUIRED".to_string());
                return;
            }

            let fut = async {
                let v: Option<Vec<u8>> = conn.get(key.clone()).await?;
                Ok::<_, redis::RedisError>((key, v))
            };

            let res = match timeout {
                Some(t) => match tokio::time::timeout(t, fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        emit_error(&ctx.app, op_id, "REDIS_COMMAND_TIMEOUT".to_string());
                        return;
                    }
                },
                None => fut.await,
            };

            match res {
                Ok((k, v)) => {
                    let row = vec![
                        CellValue::Str(k),
                        v.map(bytes_to_cell).unwrap_or(CellValue::Null),
                    ];
                    let chunk = TableChunk {
                        op_id,
                        rows: vec![row],
                        row_offset: 0,
                    };
                    let _ = tx_chunk.send(Ok(chunk)).await;
                    drop(tx_chunk);
                    let _ = emit_task.await;
                    emit_done(&ctx.app, op_id, false, 1);
                }
                Err(e) => {
                    emit_error(&ctx.app, op_id, format!("REDIS_GET_FAILED: {e}"));
                }
            }
        }

        "HGETALL" => {
            emit_meta(
                &ctx.app,
                op_id,
                vec![
                    ColumnMeta {
                        name: "field".into(),
                        db_type: "redis:string".into(),
                    },
                    ColumnMeta {
                        name: "value".into(),
                        db_type: "redis:value".into(),
                    },
                ],
            );

            let key = input.args.get(0).cloned().unwrap_or_default();
            if key.is_empty() {
                emit_error(&ctx.app, op_id, "REDIS_KEY_REQUIRED".to_string());
                return;
            }

            let fut = async {
                // Returns HashMap<String, Vec<u8>> typically, but Redis can store bytes.
                let map: std::collections::HashMap<String, Vec<u8>> = conn.hgetall(key).await?;
                Ok::<_, redis::RedisError>(map)
            };

            let map = match timeout {
                Some(t) => match tokio::time::timeout(t, fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        emit_error(&ctx.app, op_id, "REDIS_COMMAND_TIMEOUT".to_string());
                        return;
                    }
                },
                None => fut.await,
            };

            match map {
                Ok(map) => {
                    let mut rows = Vec::new();
                    let mut row_count: u64 = 0;
                    let mut row_offset: u64 = 0;

                    for (f, v) in map {
                        if row_count >= max_rows {
                            break;
                        }
                        rows.push(vec![CellValue::Str(f), bytes_to_cell(v)]);
                        row_count += 1;

                        if rows.len() >= batch_size {
                            let chunk = TableChunk {
                                op_id,
                                rows: std::mem::take(&mut rows),
                                row_offset,
                            };
                            row_offset = row_count;
                            if tx_chunk.send(Ok(chunk)).await.is_err() {
                                break;
                            }
                        }
                    }

                    if !rows.is_empty() {
                        let chunk = TableChunk {
                            op_id,
                            rows,
                            row_offset,
                        };
                        let _ = tx_chunk.send(Ok(chunk)).await;
                    }

                    drop(tx_chunk);
                    let _ = emit_task.await;

                    let truncated = row_count >= max_rows;
                    emit_done(&ctx.app, op_id, truncated, row_count);
                }
                Err(e) => emit_error(&ctx.app, op_id, format!("REDIS_HGETALL_FAILED: {e}")),
            }
        }

        "SCAN" => {
            emit_meta(
                &ctx.app,
                op_id,
                vec![ColumnMeta {
                    name: "key".into(),
                    db_type: "redis:key".into(),
                }],
            );

            let pattern = input.pattern.clone().unwrap_or("*".into());
            let count = input.scan_count.unwrap_or(200).clamp(1, 5000);

            let mut cursor: u64 = 0;
            let mut rows: Vec<Vec<CellValue>> = Vec::with_capacity(batch_size);

            let mut row_count: u64 = 0;
            let mut row_offset: u64 = 0;

            loop {
                tokio::select! {
                    _ = notify.notified() => {
                        drop(tx_chunk);
                        let _ = emit_task.await;
                        emit_done(&ctx.app, op_id, false, row_count);
                        return;
                    }

                    res = async {
                        // SCAN cursor MATCH pattern COUNT count
                        let reply: (u64, Vec<String>) = redis::cmd("SCAN")
                            .arg(cursor)
                            .arg("MATCH").arg(&pattern)
                            .arg("COUNT").arg(count)
                            .query_async(&mut conn)
                            .await?;
                        Ok::<_, redis::RedisError>(reply)
                    } => {
                        let (next_cursor, keys) = match res {
                            Ok(x) => x,
                            Err(e) => {
                                let _ = tx_chunk.send(Err(format!("REDIS_SCAN_FAILED: {e}"))).await;
                                break;
                            }
                        };

                        for k in keys {
                            if row_count >= max_rows {
                                break;
                            }
                            rows.push(vec![CellValue::Str(k)]);
                            row_count += 1;

                            if rows.len() >= batch_size {
                                let chunk = TableChunk { op_id, rows: std::mem::take(&mut rows), row_offset };
                                row_offset = row_count;
                                if tx_chunk.send(Ok(chunk)).await.is_err() {
                                    break;
                                }
                            }
                        }

                        cursor = next_cursor;
                        if cursor == 0 || row_count >= max_rows {
                            break;
                        }
                    }
                }
            }

            if !rows.is_empty() {
                let chunk = TableChunk {
                    op_id,
                    rows,
                    row_offset,
                };
                let _ = tx_chunk.send(Ok(chunk)).await;
            }

            drop(tx_chunk);
            let _ = emit_task.await;

            let truncated = row_count >= max_rows;
            emit_done(&ctx.app, op_id, truncated, row_count);
        }

        // Fallback: raw command -> one-cell result as string/json-ish
        _ => {
            emit_meta(
                &ctx.app,
                op_id,
                vec![ColumnMeta {
                    name: "result".into(),
                    db_type: "redis:value".into(),
                }],
            );

            let mut c = redis::cmd(&cmd);
            for a in &input.args {
                c.arg(a);
            }

            let fut = async {
                let v: redis::Value = c.query_async(&mut conn).await?;
                Ok::<_, redis::RedisError>(v)
            };

            let v = match timeout {
                Some(t) => match tokio::time::timeout(t, fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        emit_error(&ctx.app, op_id, "REDIS_COMMAND_TIMEOUT".to_string());
                        return;
                    }
                },
                None => fut.await,
            };

            match v {
                Ok(v) => {
                    let chunk = TableChunk {
                        op_id,
                        rows: vec![vec![value_to_cell(v)]],
                        row_offset: 0,
                    };
                    let _ = tx_chunk.send(Ok(chunk)).await;
                    drop(tx_chunk);
                    let _ = emit_task.await;
                    emit_done(&ctx.app, op_id, false, 1);
                }
                Err(e) => emit_error(&ctx.app, op_id, format!("REDIS_COMMAND_FAILED: {e}")),
            }
        }
    }
}
