use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::Value;

use crate::types::{CellValue, ColumnMeta};

const DEFAULT_API_BASE: &str = "https://api.cloudflare.com/client/v4";

#[derive(Debug, Clone)]
pub struct D1QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub row_count: u64,
}

#[derive(Debug, Deserialize)]
struct D1ApiResponse {
    success: bool,
    errors: Vec<D1ApiError>,
    result: Option<Vec<D1QueryBlock>>,
}

#[derive(Debug, Deserialize)]
struct D1ApiError {
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct D1QueryBlock {
    results: Option<Vec<Value>>,
    success: Option<bool>,
    error: Option<String>,
    meta: Option<D1QueryMeta>,
}

#[derive(Debug, Deserialize)]
struct D1QueryMeta {
    changes: Option<u64>,
}

fn query_url(api_base: &str, account_id: &str, database_id: &str) -> String {
    let base = api_base.trim_end_matches('/');
    format!("{base}/accounts/{account_id}/d1/database/{database_id}/query")
}

fn format_api_errors(errors: &[D1ApiError]) -> String {
    if errors.is_empty() {
        return "D1_API_ERROR".into();
    }
    errors
        .iter()
        .filter_map(|e| e.message.as_deref())
        .collect::<Vec<_>>()
        .join("; ")
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
        other => CellValue::Json(other.to_string()),
    }
}

fn rows_from_objects(rows: &[Value], columns: &[ColumnMeta]) -> Vec<Vec<CellValue>> {
    rows.iter()
        .filter_map(|row| row.as_object())
        .map(|obj| {
            columns
                .iter()
                .map(|col| {
                    obj.get(&col.name)
                        .map(json_value_to_cell)
                        .unwrap_or(CellValue::Null)
                })
                .collect()
        })
        .collect()
}

fn infer_columns(rows: &[Value]) -> Vec<ColumnMeta> {
    let mut names: Vec<String> = Vec::new();
    for row in rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        for key in obj.keys() {
            if !names.iter().any(|n| n == key) {
                names.push(key.clone());
            }
        }
    }
    names
        .into_iter()
        .map(|name| ColumnMeta {
            name,
            db_type: "".into(),
        })
        .collect()
}

pub async fn execute_d1_query(
    http: &reqwest::Client,
    api_base: &str,
    account_id: &str,
    database_id: &str,
    api_token: &str,
    sql: &str,
) -> Result<D1QueryResult, String> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err("D1_SQL_EMPTY".into());
    }

    let url = query_url(api_base, account_id, database_id);
    let res = http
        .post(&url)
        .header(AUTHORIZATION, format!("Bearer {api_token}"))
        .header(CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({ "sql": sql }))
        .send()
        .await
        .map_err(|e| format!("D1_HTTP_FAILED: {e}"))?;

    let status = res.status();
    let body: D1ApiResponse = res
        .json()
        .await
        .map_err(|e| format!("D1_RESPONSE_PARSE_FAILED: {e}"))?;

    if !status.is_success() || !body.success {
        let msg = format_api_errors(&body.errors);
        return Err(if msg.is_empty() {
            format!("D1_API_HTTP_{status}")
        } else {
            format!("D1_API_ERROR: {msg}")
        });
    }

    let block = body
        .result
        .and_then(|mut v| v.pop())
        .ok_or("D1_EMPTY_RESULT")?;

    if block.success == Some(false) {
        return Err(block
            .error
            .filter(|e| !e.trim().is_empty())
            .unwrap_or_else(|| "D1_QUERY_FAILED".into()));
    }

    let rows_json = block.results.unwrap_or_default();
    let columns = infer_columns(&rows_json);
    let out_rows = rows_from_objects(&rows_json, &columns);

    let row_count = if columns.is_empty() {
        block.meta.and_then(|m| m.changes).unwrap_or(0)
    } else {
        out_rows.len() as u64
    };

    Ok(D1QueryResult {
        columns,
        rows: out_rows,
        row_count,
    })
}

pub fn default_api_base(input_base: Option<&str>) -> String {
    input_base
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT_API_BASE.to_string())
}
