use futures_util::TryStreamExt;

use crate::types::{EngineKind, ImportNullMode, SqlImportCsvInput};

pub(crate) fn quote_import_identifier(ident: &str, engine: EngineKind) -> String {
    match engine {
        EngineKind::Mysql | EngineKind::Mariadb | EngineKind::Clickhouse => {
            format!("`{}`", ident.replace('`', "``"))
        }
        EngineKind::Sqlserver => format!("[{}]", ident.replace(']', "]]")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

fn quote_import_table(schema: &str, table_name: &str, engine: EngineKind) -> String {
    if schema.trim().is_empty()
        || matches!(
            engine,
            EngineKind::Sqlite | EngineKind::D1 | EngineKind::Turso | EngineKind::Duckdb
        )
    {
        return quote_import_identifier(table_name, engine);
    }
    format!(
        "{}.{}",
        quote_import_identifier(schema, engine),
        quote_import_identifier(table_name, engine)
    )
}

fn sql_string_literal(value: &str, engine: EngineKind) -> String {
    match engine {
        EngineKind::Mysql | EngineKind::Mariadb => {
            let hex = value
                .as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            format!("CONVERT(UNHEX('{hex}') USING utf8mb4)")
        }
        EngineKind::Sqlserver => format!("N'{}'", value.replace('\'', "''")),
        _ => format!("'{}'", value.replace('\'', "''")),
    }
}

fn import_type_issue(value: &str, db_type: &str) -> Option<&'static str> {
    if value.is_empty() {
        return None;
    }
    let typ = db_type.to_ascii_lowercase();
    if typ.contains("json") || typ.contains("array") {
        if serde_json::from_str::<serde_json::Value>(value).is_err() {
            return Some("Invalid JSON");
        }
        return None;
    }
    if [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "integer",
        "bigint",
        "float",
        "double",
        "real",
        "numeric",
        "decimal",
    ]
    .iter()
    .any(|prefix| typ.starts_with(prefix))
    {
        if value.parse::<f64>().map(|v| v.is_finite()).unwrap_or(false) {
            return None;
        }
        return Some("Invalid number");
    }
    if typ.contains("bool") || typ.contains("boolean") || typ.contains("bit") {
        if matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "1" | "0"
        ) {
            return None;
        }
        return Some("Invalid boolean");
    }
    None
}

fn format_import_value(value: Option<&str>, db_type: &str, engine: EngineKind) -> String {
    let Some(raw) = value else {
        return "NULL".into();
    };

    let typ = db_type.to_ascii_lowercase();
    if typ.contains("json") && raw.trim().eq_ignore_ascii_case("null") {
        return "NULL".into();
    }
    if [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "integer",
        "bigint",
        "float",
        "double",
        "real",
        "numeric",
        "decimal",
    ]
    .iter()
    .any(|prefix| typ.starts_with(prefix))
    {
        if raw.trim().eq_ignore_ascii_case("null") {
            return "NULL".into();
        }
        if let Ok(number) = raw.trim().parse::<f64>() {
            if number.is_finite() {
                return raw.trim().to_string();
            }
        }
    }

    sql_string_literal(raw, engine)
}

fn parse_csv_text(csv_text: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut chars = csv_text.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && matches!(chars.peek(), Some('"')) => {
                chars.next();
                cell.push('"');
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                row.push(std::mem::take(&mut cell));
            }
            '\n' if !in_quotes => {
                row.push(std::mem::take(&mut cell));
                if !(row.len() == 1 && row[0].is_empty() && rows.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            '\r' if !in_quotes => {
                if !matches!(chars.peek(), Some('\n')) {
                    row.push(std::mem::take(&mut cell));
                    rows.push(std::mem::take(&mut row));
                }
            }
            _ => cell.push(ch),
        }
    }

    if in_quotes {
        return Err("CSV_PARSE_FAILED: unterminated quoted field".into());
    }

    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }

    Ok(rows)
}

pub fn build_csv_import_statements(input: &SqlImportCsvInput) -> Result<Vec<String>, String> {
    let rows = parse_csv_text(&input.csv_text)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let data_rows: Vec<&Vec<String>> = if input.first_is_headers {
        rows.iter().skip(1).collect()
    } else {
        rows.iter().collect()
    };

    let import_columns = input
        .columns
        .iter()
        .filter(|col| {
            input
                .column_mapping
                .get(&col.name)
                .and_then(|v| *v)
                .is_some()
        })
        .collect::<Vec<_>>();

    if import_columns.is_empty() {
        return Err("CSV_IMPORT_NO_MAPPED_COLUMNS".into());
    }

    let validation_limit = if input.full_validation {
        data_rows.len()
    } else {
        data_rows.len().min(100)
    };

    for (row_idx, row) in data_rows.iter().take(validation_limit).enumerate() {
        for column in &import_columns {
            let Some(Some(csv_idx)) = input.column_mapping.get(&column.name) else {
                continue;
            };
            let raw = row.get(*csv_idx).map(|s| s.as_str()).unwrap_or("");
            if raw.is_empty() && matches!(input.null_mode, ImportNullMode::EmptyAsNull) {
                continue;
            }
            if let Some(reason) = import_type_issue(raw, &column.db_type) {
                let preview = raw.chars().take(32).collect::<String>();
                return Err(format!(
                    "CSV_IMPORT_VALIDATION_FAILED: row {}, column {}, value {:?}: {}",
                    row_idx + 1,
                    column.name,
                    preview,
                    reason
                ));
            }
        }
    }

    let table = quote_import_table(&input.schema, &input.table_name, input.engine);
    let quoted_columns = import_columns
        .iter()
        .map(|col| quote_import_identifier(&col.name, input.engine))
        .collect::<Vec<_>>()
        .join(", ");

    let mut statements = Vec::with_capacity(data_rows.len());
    for row in data_rows {
        let values = import_columns
            .iter()
            .map(|col| {
                let csv_idx = input
                    .column_mapping
                    .get(&col.name)
                    .and_then(|v| *v)
                    .expect("mapped import column");
                let raw = row.get(csv_idx).map(|s| s.as_str()).unwrap_or("");
                let value =
                    if raw.is_empty() && matches!(input.null_mode, ImportNullMode::EmptyAsNull) {
                        None
                    } else {
                        Some(raw)
                    };
                format_import_value(value, &col.db_type, input.engine)
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(format!(
            "INSERT INTO {table} ({quoted_columns}) VALUES ({values})"
        ));
    }

    Ok(statements)
}

pub(crate) async fn drain_sqlserver_query(
    client: &mut tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>,
    sql: &str,
) -> Result<(), String> {
    let mut stream = client
        .simple_query(sql)
        .await
        .map_err(|e| format!("SQLSERVER_QUERY_FAILED: {e}"))?;

    while stream
        .try_next()
        .await
        .map_err(|e| format!("SQLSERVER_ROW_STREAM_FAILED: {e}"))?
        .is_some()
    {}

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::types::{EngineKind, ImportNullMode, SqlImportColumnInput, SqlImportCsvInput};
    use uuid::Uuid;

    use super::build_csv_import_statements;

    #[test]
    fn validates_full_csv_import_rows() {
        let mut mapping = HashMap::new();
        mapping.insert("id".to_string(), Some(0));

        let csv_text = std::iter::once("id".to_string())
            .chain((0..101).map(|i| {
                if i == 100 {
                    "bad".to_string()
                } else {
                    i.to_string()
                }
            }))
            .collect::<Vec<_>>()
            .join("\n");

        let input = SqlImportCsvInput {
            connection_id: Uuid::nil(),
            engine: EngineKind::Postgres,
            schema: "public".into(),
            table_name: "users".into(),
            columns: vec![SqlImportColumnInput {
                name: "id".into(),
                db_type: "int".into(),
            }],
            column_mapping: mapping,
            null_mode: ImportNullMode::EmptyString,
            first_is_headers: true,
            full_validation: true,
            csv_text,
        };

        let err = build_csv_import_statements(&input).expect_err("row 101 should fail");
        assert!(err.contains("row 101"));
        assert!(err.contains("Invalid number"));
    }
}
