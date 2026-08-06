use std::time::Duration;

use reqwest::Client as ReqwestClient;
use serde::Deserialize;
use serde_json::Value;
use urlencoding::encode;

use crate::engines::clickhouse::config::build_http_url;
use crate::engines::clickhouse::connection::ClickhouseConn;
use crate::engines::clickhouse::convert::{
    clickhouse_decimal_scale, clickhouse_decimal_to_cell_i64, unwrap_clickhouse_type_str,
};
use crate::engines::clickhouse::response::{ChJsonMeta, ChJsonResponse};
use crate::engines::clickhouse::sql::{
    looks_like_query, normalize_clickhouse_statement, split_clickhouse_statements,
};
use crate::types::secret::{SecretRef, SecretRefKind};
use crate::types::{CellValue, ClickhouseConnectInput};

#[derive(Debug, Deserialize)]
struct ChJsonMetaRaw {
    name: String,
    #[serde(rename = "type")]
    db_type: String,
}

#[derive(Debug, Deserialize)]
struct ChJsonRaw {
    meta: Option<Vec<ChJsonMetaRaw>>,
    data: Option<Vec<Value>>,
    rows: Option<u64>,
}

fn json_value_to_cell(v: &Value, db_type: Option<&str>) -> CellValue {
    let db_type = db_type.map(unwrap_clickhouse_type_str);
    let db_type_ref = db_type.as_deref();
    if let Some(scale) = db_type_ref.and_then(clickhouse_decimal_scale) {
        if scale > 0 {
            match v {
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        return clickhouse_decimal_to_cell_i64(i, scale);
                    }
                    if let Some(f) = n.as_f64() {
                        return CellValue::F64(f);
                    }
                }
                Value::String(s) => {
                    let t = s.trim();
                    // Human-readable decimal from JSON (e.g. "6941.00")
                    if t.contains('.') {
                        if let Ok(f) = t.parse::<f64>() {
                            return CellValue::F64(f);
                        }
                    }
                    if let Ok(i) = t.parse::<i64>() {
                        return clickhouse_decimal_to_cell_i64(i, scale);
                    }
                }
                _ => {}
            }
        }
    }

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

fn parse_clickhouse_json_response(text: &str) -> Result<ChJsonResponse, String> {
    let raw: ChJsonRaw =
        serde_json::from_str(text).map_err(|e| format!("CLICKHOUSE_JSON_PARSE_FAILED: {e}"))?;

    let meta: Vec<ChJsonMeta> = raw
        .meta
        .unwrap_or_default()
        .into_iter()
        .map(|m| ChJsonMeta {
            name: m.name,
            db_type: m.db_type,
        })
        .collect();

    let mut matrix: Vec<Vec<CellValue>> = Vec::new();
    if let Some(data) = raw.data {
        for row in data {
            let cells = match row {
                Value::Array(vals) => vals
                    .iter()
                    .zip(meta.iter())
                    .map(|(v, col)| json_value_to_cell(v, Some(col.db_type.as_str())))
                    .collect(),
                Value::Object(map) => meta
                    .iter()
                    .map(|col| {
                        map.get(&col.name)
                            .map(|v| json_value_to_cell(v, Some(col.db_type.as_str())))
                            .unwrap_or(CellValue::Null)
                    })
                    .collect(),
                Value::Null => Vec::new(),
                other => vec![json_value_to_cell(&other, None)],
            };
            matrix.push(cells);
        }
    }

    let rows = raw.rows.unwrap_or(matrix.len() as u64);

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

fn prepare_clickhouse_http_body(sql: &str, json_result: bool) -> String {
    let stmt = normalize_clickhouse_statement(sql);
    if !json_result {
        return stmt;
    }
    if stmt.to_uppercase().contains("FORMAT ") {
        stmt
    } else {
        format!("{stmt} FORMAT JSONCompact")
    }
}

fn connect_input_from_conn(conn: &ClickhouseConn) -> ClickhouseConnectInput {
    ClickhouseConnectInput {
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        user: conn.user.clone(),
        password: SecretRef {
            kind: SecretRefKind::Inline,
            value: conn.password.clone(),
        },
        protocol: Some(crate::types::ClickhouseProtocol::Http),
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
    let base_url = build_http_url(&input);
    let database = conn.database.trim();
    let mut url = format!("{base_url}/");
    if json_result {
        url.push_str("?default_format=JSONCompact");
    }
    if !database.is_empty() {
        url.push_str(if json_result { "&" } else { "?" });
        url.push_str("database=");
        url.push_str(&encode(database));
    }

    let body = prepare_clickhouse_http_body(&stmt, json_result);

    let http = ReqwestClient::builder()
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
            tokio::time::timeout(Duration::from_millis(ms), fut)
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
