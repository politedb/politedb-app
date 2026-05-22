use std::sync::Arc;
use std::time::Instant;

use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;
use tauri::Emitter;
use tokio::sync::Notify;

use crate::engines::cancel::CancelHandle;
use crate::engines::clickhouse::config::build_url;
use crate::engines::clickhouse::connection::ClickhouseConn;
use crate::operations::ctx::{ActiveGuard, OperationCtx, RunningGuard};
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ClickhouseConnectInput, ColumnMeta, SqlQueryInput, TableChunk};

#[derive(Debug, Deserialize)]
pub(crate) struct ChJsonMeta {
    name: String,
    #[serde(rename = "type")]
    db_type: String,
}

#[derive(Debug, Deserialize)]
struct ChJsonRaw {
    meta: Option<Vec<ChJsonMeta>>,
    data: Option<Vec<Value>>,
    rows: Option<u64>,
}

#[derive(Debug)]
pub(crate) struct ChJsonResponse {
    pub meta: Option<Vec<ChJsonMeta>>,
    pub data: Option<Vec<Vec<Value>>>,
    pub rows: Option<u64>,
}

fn parse_clickhouse_json_response(text: &str) -> Result<ChJsonResponse, String> {
    let raw: ChJsonRaw =
        serde_json::from_str(text).map_err(|e| format!("CLICKHOUSE_JSON_PARSE_FAILED: {e}"))?;

    let meta = raw.meta.unwrap_or_default();
    let mut matrix: Vec<Vec<Value>> = Vec::new();

    if let Some(data) = raw.data {
        for row in data {
            match row {
                Value::Array(vals) => matrix.push(vals),
                Value::Object(map) => {
                    let vals = meta
                        .iter()
                        .map(|col| map.get(&col.name).cloned().unwrap_or(Value::Null))
                        .collect();
                    matrix.push(vals);
                }
                Value::Null => matrix.push(Vec::new()),
                other => matrix.push(vec![other]),
            }
        }
    }

    let rows = raw
        .rows
        .unwrap_or(matrix.len() as u64);

    Ok(ChJsonResponse {
        meta: if meta.is_empty() { None } else { Some(meta) },
        data: if matrix.is_empty() {
            None
        } else {
            Some(matrix)
        },
        rows: Some(rows),
    })
}

/// ClickHouse HTTP allows one statement per request; strip trailing `;` before format clause.
fn normalize_clickhouse_statement(sql: &str) -> String {
    sql.trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .to_string()
}

fn split_clickhouse_statements(sql: &str) -> Vec<String> {
    sql.split(';')
        .map(normalize_clickhouse_statement)
        .filter(|s| !s.is_empty())
        .collect()
}

fn prepare_clickhouse_http_body(sql: &str, json_result: bool) -> String {
    let stmt = normalize_clickhouse_statement(sql);
    if !json_result {
        return stmt;
    }
    if stmt.to_uppercase().contains("FORMAT ") {
        stmt
    } else {
        // JSONCompact => `data` is [[col1, col2], ...]; plain JSON uses objects per row.
        format!("{stmt} FORMAT JSONCompact")
    }
}

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
        || up.starts_with("DESC")
        || up.starts_with("EXPLAIN")
}

fn json_value_to_cell(v: &Value) -> CellValue {
    match v {
        Value::Null => CellValue::Null,
        Value::Bool(b) => CellValue::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                CellValue::I64(i)
            } else if let Some(f) = n.as_f64() {
                CellValue::F64(f)
            } else {
                CellValue::Str(n.to_string())
            }
        }
        Value::String(s) => CellValue::Str(s.clone()),
        Value::Array(arr) => {
            CellValue::Str(serde_json::to_string(arr).unwrap_or_else(|_| "[]".to_string()))
        }
        Value::Object(obj) => {
            CellValue::Str(serde_json::to_string(obj).unwrap_or_else(|_| "{}".to_string()))
        }
    }
}

fn connect_input_from_conn(conn: &ClickhouseConn) -> ClickhouseConnectInput {
    use crate::types::secret::{SecretRef, SecretRefKind};

    ClickhouseConnectInput {
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        user: conn.user.clone(),
        password: SecretRef {
            kind: SecretRefKind::Inline,
            value: conn.password.clone(),
        },
        ssl_mode: conn.ssl_mode.clone(),
        connect_timeout_ms: conn.connect_timeout_ms,
        statement_timeout_ms: conn.default_statement_timeout_ms,
    }
}

async fn execute_clickhouse_http(
    conn: &ClickhouseConn,
    sql: &str,
    json_result: bool,
    timeout_ms: Option<u64>,
) -> Result<Option<ChJsonResponse>, String> {
    let stmt = normalize_clickhouse_statement(sql);
    if stmt.is_empty() {
        return Err("CLICKHOUSE_SQL_EMPTY".into());
    }

    let input = connect_input_from_conn(conn);
    let base_url = build_url(&input);
    let database = conn.database.trim();
    let mut url = format!("{base_url}/");
    if json_result {
        url.push_str("?default_format=JSONCompact");
    }
    if !database.is_empty() {
        url.push_str(if json_result { "&" } else { "?" });
        url.push_str("database=");
        url.push_str(&urlencoding::encode(database));
    }

    let body = prepare_clickhouse_http_body(&stmt, json_result);

    let http = HttpClient::builder()
        .build()
        .map_err(|e| format!("CLICKHOUSE_HTTP_CLIENT_FAILED: {e}"))?;

    let req = http
        .post(&url)
        .basic_auth(&conn.user, Some(&conn.password))
        .body(body);

    let fut = req.send();
    let resp = match timeout_ms {
        Some(ms) => {
            let ms = ms.clamp(100, 300_000);
            tokio::time::timeout(std::time::Duration::from_millis(ms), fut)
                .await
                .map_err(|_| format!("CLICKHOUSE_QUERY_TIMEOUT after {ms}ms"))?
        }
        None => fut.await,
    }
    .map_err(|e| format!("CLICKHOUSE_HTTP_REQUEST_FAILED: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("CLICKHOUSE_HTTP_BODY_FAILED: {e}"))?;

    if !status.is_success() {
        return Err(format!("CLICKHOUSE_QUERY_FAILED: {text}"));
    }

    if !json_result {
        return Ok(None);
    }

    if text.trim().is_empty() {
        return Ok(Some(ChJsonResponse {
            meta: None,
            data: None,
            rows: Some(0),
        }));
    }

    parse_clickhouse_json_response(&text)
        .map(Some)
        .map_err(|e| format!("{e}: {text}"))
}

pub async fn execute_json_query(
    conn: &ClickhouseConn,
    sql: &str,
    timeout_ms: Option<u64>,
) -> Result<ChJsonResponse, String> {
    execute_clickhouse_batch(conn, sql, timeout_ms).await
}

/// Run one or more statements (split on `;`). Returns JSON for the last SELECT-like statement.
pub async fn execute_clickhouse_batch(
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
            last_json = execute_clickhouse_http(conn, stmt, true, timeout_ms).await?;
        } else {
            execute_clickhouse_http(conn, stmt, false, timeout_ms).await?;
        }
    }

    Ok(last_json.unwrap_or(ChJsonResponse {
        meta: None,
        data: None,
        rows: Some(0),
    }))
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
                        execute_clickhouse_http(
                            &conn,
                            &format!("EXPLAIN {stmt}"),
                            true,
                            timeout_ms,
                        )
                        .await?;
                    } else {
                        execute_clickhouse_http(&conn, stmt, false, timeout_ms).await?;
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
    let last_stmt = statements.last().map(String::as_str).unwrap_or(sql.as_str());
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
            let cells = row.iter().map(json_value_to_cell).collect();
            out_rows.push(cells);
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
