use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{CellValue, ColumnMeta};

const API_BASE: &str = "https://sheets.googleapis.com/v4/spreadsheets";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleSheetInfo {
    pub title: String,
    pub row_count: usize,
    pub column_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleSheetsMetadata {
    pub spreadsheet_title: String,
    pub sheets: Vec<GoogleSheetInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleSheetOverview {
    pub columns: Vec<ColumnMeta>,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleSheetRows {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub row_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpreadsheetResponse {
    properties: SpreadsheetProperties,
    #[serde(default)]
    sheets: Vec<SheetResponse>,
}

#[derive(Debug, Deserialize)]
struct SpreadsheetProperties {
    title: String,
}

#[derive(Debug, Deserialize)]
struct SheetResponse {
    properties: SheetProperties,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SheetProperties {
    title: String,
    #[serde(default)]
    grid_properties: GridProperties,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GridProperties {
    #[serde(default)]
    row_count: usize,
    #[serde(default)]
    column_count: usize,
}

#[derive(Debug, Deserialize)]
struct ValuesResponse {
    #[serde(default)]
    values: Vec<Vec<Value>>,
}

pub fn normalize_spreadsheet_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("GOOGLE_SHEETS_SPREADSHEET_REQUIRED".into());
    }

    if let Some(rest) = value.split("/spreadsheets/d/").nth(1) {
        let id = rest.split('/').next().unwrap_or_default().trim();
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }

    if value.contains('/') || value.contains(char::is_whitespace) {
        return Err("GOOGLE_SHEETS_SPREADSHEET_INVALID".into());
    }

    Ok(value.to_string())
}

fn with_auth(request: RequestBuilder, credential: &str) -> RequestBuilder {
    let credential = credential.trim();
    if let Some(token) = credential.strip_prefix("Bearer ") {
        request.bearer_auth(token.trim())
    } else if credential.starts_with("ya29.") {
        request.bearer_auth(credential)
    } else {
        request.query(&[("key", credential)])
    }
}

async fn parse_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "GOOGLE_SHEETS_RESPONSE_READ_FAILED".to_string())?;

    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| status.to_string());
        return Err(format!("GOOGLE_SHEETS_API_FAILED: {message}"));
    }

    serde_json::from_str(&body).map_err(|_| "GOOGLE_SHEETS_RESPONSE_INVALID".to_string())
}

pub async fn fetch_metadata(
    http: &Client,
    spreadsheet_id: &str,
    credential: &str,
) -> Result<GoogleSheetsMetadata, String> {
    let url = format!("{API_BASE}/{spreadsheet_id}");
    let request = http.get(url).query(&[
        ("includeGridData", "false"),
        ("fields", "properties.title,sheets.properties"),
    ]);
    let data: SpreadsheetResponse = parse_response(
        with_auth(request, credential)
            .send()
            .await
            .map_err(|_| "GOOGLE_SHEETS_REQUEST_FAILED".to_string())?,
    )
    .await?;

    Ok(GoogleSheetsMetadata {
        spreadsheet_title: data.properties.title,
        sheets: data
            .sheets
            .into_iter()
            .map(|sheet| GoogleSheetInfo {
                title: sheet.properties.title,
                row_count: sheet.properties.grid_properties.row_count.saturating_sub(1),
                column_count: sheet.properties.grid_properties.column_count,
            })
            .collect(),
    })
}

async fn fetch_values(
    http: &Client,
    spreadsheet_id: &str,
    credential: &str,
    range: &str,
) -> Result<Vec<Vec<Value>>, String> {
    let range = urlencoding::encode(range);
    let url = format!("{API_BASE}/{spreadsheet_id}/values/{range}");
    let request = http.get(url).query(&[
        ("majorDimension", "ROWS"),
        ("valueRenderOption", "UNFORMATTED_VALUE"),
    ]);
    let data: ValuesResponse = parse_response(
        with_auth(request, credential)
            .send()
            .await
            .map_err(|_| "GOOGLE_SHEETS_REQUEST_FAILED".to_string())?,
    )
    .await?;
    Ok(data.values)
}

fn sheet_range(sheet: &str, rows: &str) -> String {
    format!("'{}'!{rows}", sheet.replace('\'', "''"))
}

fn column_name(index: usize) -> String {
    format!("Column {}", index + 1)
}

fn normalize_columns(header: &[Value], width: usize) -> Vec<ColumnMeta> {
    let mut used = std::collections::HashMap::<String, usize>::new();
    (0..width)
        .map(|index| {
            let base = header
                .get(index)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| column_name(index));
            let count = used.entry(base.clone()).or_insert(0);
            *count += 1;
            let name = if *count == 1 {
                base
            } else {
                format!("{base} {}", *count)
            };
            ColumnMeta {
                name,
                db_type: "string".into(),
            }
        })
        .collect()
}

fn to_cell(value: Value) -> CellValue {
    match value {
        Value::Null => CellValue::Null,
        Value::Bool(value) => CellValue::Bool(value),
        Value::Number(value) => value
            .as_i64()
            .map(CellValue::I64)
            .or_else(|| value.as_f64().map(CellValue::F64))
            .unwrap_or_else(|| CellValue::Str(value.to_string())),
        Value::String(value) => CellValue::Str(value),
        value => CellValue::Json(value.to_string()),
    }
}

pub async fn fetch_overview(
    http: &Client,
    spreadsheet_id: &str,
    credential: &str,
    sheet: &str,
    row_count: usize,
    column_count: usize,
) -> Result<GoogleSheetOverview, String> {
    let header = fetch_values(http, spreadsheet_id, credential, &sheet_range(sheet, "1:1"))
        .await?
        .into_iter()
        .next()
        .unwrap_or_default();
    let width = column_count.max(header.len());
    Ok(GoogleSheetOverview {
        columns: normalize_columns(&header, width),
        row_count,
    })
}

pub async fn fetch_rows(
    http: &Client,
    spreadsheet_id: &str,
    credential: &str,
    sheet: &str,
    limit: usize,
    offset: usize,
) -> Result<GoogleSheetRows, String> {
    let header = fetch_values(http, spreadsheet_id, credential, &sheet_range(sheet, "1:1"))
        .await?
        .into_iter()
        .next()
        .unwrap_or_default();
    let start = offset.saturating_add(2);
    let end = start.saturating_add(limit.max(1)).saturating_sub(1);
    let raw_rows = fetch_values(
        http,
        spreadsheet_id,
        credential,
        &sheet_range(sheet, &format!("{start}:{end}")),
    )
    .await?;
    let width = raw_rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or_default()
        .max(header.len());
    let columns = normalize_columns(&header, width);
    let rows = raw_rows
        .into_iter()
        .map(|row| {
            let mut values = row.into_iter().map(to_cell).collect::<Vec<_>>();
            values.resize(width, CellValue::Null);
            values
        })
        .collect::<Vec<_>>();
    let row_count = offset + rows.len() + usize::from(rows.len() == limit);
    Ok(GoogleSheetRows {
        columns,
        rows,
        row_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_google_sheet_url() {
        assert_eq!(
            normalize_spreadsheet_id(
                "https://docs.google.com/spreadsheets/d/sheet-id-123/edit#gid=0"
            )
            .unwrap(),
            "sheet-id-123"
        );
    }

    #[test]
    fn normalizes_duplicate_headers() {
        let header = vec![Value::String("name".into()), Value::String("name".into())];
        let names = normalize_columns(&header, 3)
            .into_iter()
            .map(|column| column.name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["name", "name 2", "Column 3"]);
    }
}
