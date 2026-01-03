use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use futures_util::{pin_mut, StreamExt};

use crate::engines::EngineConnection;
use crate::state::AppState;
use crate::types::{
    ColumnMeta, OperationDone, OperationError, OperationExecuteInput, OperationKind,
    OperationStarted, TableChunk,
};

use crate::engines::postgres::row_codec;

/// Cancel a running operation (hard cancel for Postgres)
#[tauri::command]
pub async fn operation_cancel(state: State<'_, AppState>, op_id: Uuid) -> Result<(), String> {
    if let Some((_, token)) = state.running_ops.remove(&op_id) {
        // Cancel at PostgreSQL backend level
        tokio::spawn(async move {
            let _ = token.cancel_query(tokio_postgres::NoTls).await;
        });
    }
    Ok(())
}

/// Execute an operation (Postgres SQL for now, multi-engine ready)
#[tauri::command]
pub async fn operation_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    input: OperationExecuteInput,
) -> Result<Uuid, String> {
    let conn = state
        .connections
        .get(&input.connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?
        .clone();

    let op_id = Uuid::new_v4();

    app.emit(
        "op:started",
        OperationStarted {
            op_id,
            connection_id: input.connection_id,
        },
    )
    .map_err(|e| e.to_string())?;

    match (input.kind, conn) {
        // ------------------------------------------------------------------
        // PostgreSQL SQL query
        // ------------------------------------------------------------------
        (OperationKind::SqlQuery, EngineConnection::Postgres(pg)) => {
            let sql_input = input.sql.ok_or("SQL_PAYLOAD_MISSING")?;

            let batch_size = sql_input.batch_size.unwrap_or(200).max(1) as usize;
            let max_rows = sql_input.max_rows.unwrap_or(50_000).max(1) as u64;

            let pool = pg.pool.clone();
            let app_handle = app.clone();

            // ✅ Clone only the shared map, not `State<'_ , AppState>`
            let running_ops = state.running_ops.clone();

            tokio::spawn(async move {
                let mut row_count: u64 = 0;
                let mut row_offset: u64 = 0;

                // Acquire client from pool
                let client = match pool.get().await {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = app_handle.emit(
                            "op:error",
                            OperationError {
                                op_id,
                                error: format!("POOL_GET_FAILED: {}", e),
                            },
                        );
                        return;
                    }
                };

                // Register cancel token
                let cancel_token = client.cancel_token();
                running_ops.insert(op_id, cancel_token);

                // Prepare statement
                let stmt = match client.prepare(&sql_input.sql).await {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = app_handle.emit(
                            "op:error",
                            OperationError {
                                op_id,
                                error: format!("PREPARE_FAILED: {}", e),
                            },
                        );
                        running_ops.remove(&op_id);
                        return;
                    }
                };

                // Column metadata (once)
                let columns: Vec<ColumnMeta> = stmt
                    .columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        db_type: row_codec::column_type_name(c.type_()),
                    })
                    .collect();

                // Stream rows
                let stream = match client.query_raw(&stmt, std::iter::empty::<&str>()).await {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = app_handle.emit(
                            "op:error",
                            OperationError {
                                op_id,
                                error: format!("QUERY_FAILED: {}", e),
                            },
                        );
                        running_ops.remove(&op_id);
                        return;
                    }
                };

                // ✅ Pin stream because RowStream is !Unpin
                pin_mut!(stream);

                let mut batch_rows: Vec<Vec<serde_json::Value>> = Vec::with_capacity(batch_size);

                while let Some(row_result) = stream.next().await {
                    let row = match row_result {
                        Ok(r) => r,
                        Err(e) => {
                            let _ = app_handle.emit(
                                "op:error",
                                OperationError {
                                    op_id,
                                    error: format!("ROW_STREAM_FAILED: {}", e),
                                },
                            );
                            running_ops.remove(&op_id);
                            return;
                        }
                    };

                    if row_count >= max_rows {
                        break;
                    }

                    batch_rows.push(row_codec::row_to_json_vec(&row));
                    row_count += 1;

                    if batch_rows.len() >= batch_size {
                        let chunk = TableChunk {
                            op_id,
                            columns: columns.clone(),
                            rows: std::mem::take(&mut batch_rows),
                            row_offset,
                        };

                        row_offset = row_count;

                        let _ = app_handle.emit("op:chunk_table", chunk);
                    }
                }

                // Flush remaining rows
                if !batch_rows.is_empty() {
                    let chunk = TableChunk {
                        op_id,
                        columns: columns.clone(),
                        rows: batch_rows,
                        row_offset,
                    };
                    let _ = app_handle.emit("op:chunk_table", chunk);
                }

                let truncated = row_count >= max_rows;

                let _ = app_handle.emit(
                    "op:done",
                    OperationDone {
                        op_id,
                        truncated,
                        row_count,
                    },
                );

                running_ops.remove(&op_id);
            });

            Ok(op_id)
        }

        // ------------------------------------------------------------------
        // Unsupported engine / operation
        // ------------------------------------------------------------------
        _ => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
    }
}
