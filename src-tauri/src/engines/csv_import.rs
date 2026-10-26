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

/// The single-character field separator, or comma when none (or an
/// unusable one) is given.
fn import_delimiter(delimiter: Option<&str>) -> char {
    match delimiter {
        Some(d) => {
            let mut chars = d.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if c != '"' && c != '\n' && c != '\r' => c,
                _ => ',',
            }
        }
        None => ',',
    }
}

/// Split CSV text into records. The import preview (`parseCsvRecords` in
/// src/utils/csv.ts) follows the same rules, so preview and import agree:
/// a leading BOM is dropped; LF, CRLF and CR end a record; a quote only
/// starts a quoted value at the start of a field (elsewhere it is an
/// ordinary character); inside quotes a doubled quote is a quote; anything
/// but a separator or line end after a closing quote is an error; a line
/// with nothing on it is skipped (a quoted empty value `""` is a record);
/// an unterminated quote is an error.
fn parse_csv_text(csv_text: &str, delimiter: char) -> Result<Vec<Vec<String>>, String> {
    let text = csv_text.strip_prefix('\u{feff}').unwrap_or(csv_text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut chars = text.chars().peekable();
    let mut in_quotes = false;
    let mut field_start = true;
    let mut after_close = false;
    let mut row_quoted = false;

    fn end_record(
        rows: &mut Vec<Vec<String>>,
        row: &mut Vec<String>,
        cell: &mut String,
        row_quoted: &mut bool,
    ) {
        row.push(std::mem::take(cell));
        let blank_line = row.len() == 1 && row[0].is_empty() && !*row_quoted;
        if blank_line {
            row.clear();
        } else {
            rows.push(std::mem::take(row));
        }
        *row_quoted = false;
    }

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    chars.next();
                    cell.push('"');
                } else {
                    in_quotes = false;
                    after_close = true;
                }
            } else {
                cell.push(ch);
            }
            continue;
        }
        match ch {
            '"' if field_start => {
                in_quotes = true;
                row_quoted = true;
                field_start = false;
            }
            c if c == delimiter => {
                row.push(std::mem::take(&mut cell));
                field_start = true;
                after_close = false;
            }
            '\n' | '\r' => {
                if ch == '\r' && matches!(chars.peek(), Some('\n')) {
                    chars.next();
                }
                end_record(&mut rows, &mut row, &mut cell, &mut row_quoted);
                field_start = true;
                after_close = false;
            }
            _ if after_close => {
                return Err(format!(
                    "CSV_PARSE_FAILED: unexpected text after a closing quote in record {}",
                    rows.len() + 1
                ));
            }
            _ => {
                cell.push(ch);
                field_start = false;
            }
        }
    }

    if in_quotes {
        return Err("CSV_PARSE_FAILED: unterminated quoted field".into());
    }

    if !cell.is_empty() || !row.is_empty() || row_quoted {
        end_record(&mut rows, &mut row, &mut cell, &mut row_quoted);
    }

    Ok(rows)
}

pub fn build_csv_import_statements(input: &SqlImportCsvInput) -> Result<Vec<String>, String> {
    let rows = parse_csv_text(
        &input.csv_text,
        import_delimiter(input.delimiter.as_deref()),
    )?;
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

    use super::{build_csv_import_statements, import_delimiter, parse_csv_text};

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
            delimiter: None,
        };

        let err = build_csv_import_statements(&input).expect_err("row 101 should fail");
        assert!(err.contains("row 101"));
        assert!(err.contains("Invalid number"));
    }

    #[test]
    fn splits_on_the_chosen_delimiter() {
        let rows = parse_csv_text("id;name\n1;\"a;b\"\n", ';').unwrap();
        assert_eq!(rows, vec![vec!["id", "name"], vec!["1", "a;b"]]);
        let rows = parse_csv_text("id\tname\n1\tAda", '\t').unwrap();
        assert_eq!(rows[1], vec!["1", "Ada"]);
        // Commas stay inside a semicolon file's values.
        let rows = parse_csv_text("a;b\n1,5;2", ';').unwrap();
        assert_eq!(rows[1], vec!["1,5", "2"]);
    }

    #[test]
    fn falls_back_to_comma_for_unusable_delimiters() {
        assert_eq!(import_delimiter(None), ',');
        assert_eq!(import_delimiter(Some(";")), ';');
        assert_eq!(import_delimiter(Some("\t")), '\t');
        assert_eq!(import_delimiter(Some("")), ',');
        assert_eq!(import_delimiter(Some(";;")), ',');
        assert_eq!(import_delimiter(Some("\"")), ',');
    }

    /// Shared with src/utils/csv.parity.test.ts: keep both in step.
    #[test]
    fn records_match_the_preview_rules() {
        let parse = |t: &str| parse_csv_text(t, ',').unwrap();
        // BOM dropped; trailing newline adds nothing.
        assert_eq!(
            parse("\u{feff}id,name\n1,Ada\n"),
            vec![vec!["id", "name"], vec!["1", "Ada"]]
        );
        // Blank lines anywhere are skipped; CRLF and CR end records.
        assert_eq!(
            parse("\n\nid\r\n\r\n1\r2\n\n"),
            vec![vec!["id"], vec!["1"], vec!["2"]]
        );
        // A quoted empty value is a record.
        assert_eq!(parse("name\n\"\"\n"), vec![vec!["name"], vec![""]]);
        // Delimiters, quotes and newlines inside quotes stay in the value.
        assert_eq!(
            parse("a,b\n\"x,\"\"y\"\"\nz\",2"),
            vec![vec!["a", "b"], vec!["x,\"y\"\nz", "2"]]
        );
        assert!(parse_csv_text("a\n\"open", ',').is_err());
        // A quote inside an unquoted value is an ordinary character.
        assert_eq!(
            parse("name\na\"b\"c\n12\" widget\n"),
            vec![vec!["name"], vec!["a\"b\"c"], vec!["12\" widget"]]
        );
        // Text after a closing quote is an error, not silently joined.
        assert!(parse_csv_text("name\n\"a\"oops\n", ',').is_err());
        // A closing quote may be followed by the separator or a line end.
        assert_eq!(parse("\"a\",\"b\"\r\n"), vec![vec!["a", "b"]]);
    }

    #[test]
    fn splits_every_separator_the_same_way() {
        for d in [',', ';', '\t', '|'] {
            let text = format!("a{d}\"b{d}c\"\n1{d}2");
            assert_eq!(
                parse_csv_text(&text, d).unwrap(),
                vec![
                    vec!["a".to_string(), format!("b{d}c")],
                    vec!["1".into(), "2".into()]
                ]
            );
        }
    }
}
