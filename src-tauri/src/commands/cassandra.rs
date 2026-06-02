use std::collections::HashMap;
use std::convert::TryInto;

use chrono::{NaiveDate, TimeZone, Utc};
use num_bigint::BigInt;
use scylla::value::{CqlDate, CqlDecimal, CqlTime, CqlTimestamp, CqlValue, CqlVarint, Row};
use scylla::DeserializeRow;
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use crate::engines::EngineConnection;
use crate::state::AppState;
use crate::types::{CellValue, ColumnMeta};

#[derive(serde::Serialize)]
pub struct CassandraTableOverview {
    pub columns: Vec<ColumnMeta>,
    pub row_count: u64,
}

#[derive(serde::Serialize)]
pub struct CassandraQueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub row_count: u64,
}

fn cassandra_conn<'a>(
    state: &'a AppState,
    connection_id: Uuid,
) -> Result<dashmap::mapref::one::Ref<'a, Uuid, EngineConnection>, String> {
    let conn = state
        .connections
        .get(&connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?;

    match conn.value() {
        EngineConnection::Cassandra(_) => Ok(conn),
        _ => Err("ENGINE_NOT_SUPPORTED".into()),
    }
}

fn as_cassandra_session(
    conn: &dashmap::mapref::one::Ref<'_, Uuid, EngineConnection>,
) -> Result<
    (
        std::sync::Arc<scylla::client::session::Session>,
        Option<String>,
    ),
    String,
> {
    match conn.value() {
        EngineConnection::Cassandra(cassandra) => Ok((
            cassandra.session.clone(),
            cassandra.default_keyspace.clone(),
        )),
        _ => Err("ENGINE_NOT_SUPPORTED".into()),
    }
}

fn normalize_keyspace_arg(
    keyspace: Option<String>,
    default_keyspace: Option<String>,
) -> Result<String, String> {
    keyspace
        .or(default_keyspace)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or("CASSANDRA_KEYSPACE_REQUIRED".into())
}

fn validate_identifier(name: &str, label: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(format!("CASSANDRA_{label}_REQUIRED"));
    }
    if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        || !n
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic() || c == '_')
            .unwrap_or(false)
    {
        return Err(format!("CASSANDRA_{label}_INVALID"));
    }
    Ok(())
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.trim().replace('"', "\"\""))
}

fn format_decimal_with_scale(abs_digits: &str, scale: i32) -> String {
    let scale = scale.max(0) as usize;
    let abs_digits = if abs_digits.is_empty() {
        "0"
    } else {
        abs_digits.trim_start_matches('0')
    };
    let abs_digits = if abs_digits.is_empty() {
        "0"
    } else {
        abs_digits
    };

    if scale == 0 {
        return abs_digits.to_string();
    }

    let padded = if abs_digits.len() <= scale {
        format!("{:0>width$}", abs_digits, width = scale + 1)
    } else {
        abs_digits.to_string()
    };

    let split = padded.len().saturating_sub(scale);
    if split == 0 {
        format!("0.{padded}")
    } else {
        format!("{}.{}", &padded[..split], &padded[split..])
    }
}

fn cql_decimal_to_string(d: &CqlDecimal) -> String {
    let (bytes, scale) = d.as_signed_be_bytes_slice_and_exponent();
    let s = BigInt::from_signed_bytes_be(bytes).to_string();
    let negative = s.starts_with('-');
    let abs_digits = s.trim_start_matches('-');
    let mut out = format_decimal_with_scale(abs_digits, scale);
    if negative && out != "0" {
        out.insert(0, '-');
    }
    out
}

fn cql_varint_to_string(v: &CqlVarint) -> String {
    BigInt::from_signed_bytes_be(v.as_signed_bytes_be_slice()).to_string()
}

fn cql_timestamp_to_string(t: CqlTimestamp) -> String {
    match Utc.timestamp_millis_opt(t.0).single() {
        Some(dt) => dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
        None => t.0.to_string(),
    }
}

fn cql_date_to_string(d: CqlDate) -> String {
    let parsed: Result<NaiveDate, _> = d.try_into();
    match parsed {
        Ok(date) => date.format("%Y-%m-%d").to_string(),
        Err(_) => d.0.to_string(),
    }
}

fn cql_time_to_string(t: &CqlTime) -> String {
    let nanos = t.0;
    format!(
        "{:02}:{:02}:{:02}.{:09}",
        nanos / 3_600_000_000_000,
        nanos / 60_000_000_000 % 60,
        nanos / 1_000_000_000 % 60,
        nanos % 1_000_000_000
    )
}

fn cql_value_to_cell(value: Option<CqlValue>) -> CellValue {
    match value {
        None => CellValue::Null,
        Some(v) => match &v {
            CqlValue::Boolean(b) => CellValue::Bool(*b),
            CqlValue::Int(i) => CellValue::I64(*i as i64),
            CqlValue::SmallInt(i) => CellValue::I64(*i as i64),
            CqlValue::TinyInt(i) => CellValue::I64(*i as i64),
            CqlValue::BigInt(i) => CellValue::I64(*i),
            CqlValue::Counter(c) => CellValue::I64(c.0),
            CqlValue::Float(f) => CellValue::F64(*f as f64),
            CqlValue::Double(f) => CellValue::F64(*f),
            CqlValue::Ascii(s) | CqlValue::Text(s) => CellValue::Str(s.clone()),
            CqlValue::Blob(b) => CellValue::BytesB64(base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                b,
            )),
            CqlValue::Uuid(u) => CellValue::Str(u.to_string()),
            CqlValue::Timeuuid(u) => CellValue::Str(u.to_string()),
            CqlValue::Timestamp(t) => CellValue::Str(cql_timestamp_to_string(*t)),
            CqlValue::Date(d) => CellValue::Str(cql_date_to_string(*d)),
            CqlValue::Time(t) => CellValue::Str(cql_time_to_string(t)),
            CqlValue::Inet(ip) => CellValue::Str(ip.to_string()),
            CqlValue::Decimal(d) => CellValue::Str(cql_decimal_to_string(d)),
            CqlValue::Varint(v) => CellValue::Str(cql_varint_to_string(v)),
            CqlValue::Empty => CellValue::Null,
            // Collections, UDT, etc. — use CQL-style Display, not Debug
            other => CellValue::Str(format!("{other}")),
        },
    }
}

fn rows_to_result(
    rows_result: scylla::response::query_result::QueryRowsResult,
) -> Result<(Vec<ColumnMeta>, Vec<Vec<CellValue>>), String> {
    let columns: Vec<ColumnMeta> = rows_result
        .column_specs()
        .iter()
        .map(|spec| ColumnMeta {
            name: spec.name().to_string(),
            db_type: format!("{:?}", spec.typ()),
        })
        .collect();

    let mut rows = Vec::new();
    let mut iter = rows_result
        .rows::<Row>()
        .map_err(|e| format!("CASSANDRA_ROWS_TYPECHECK_FAILED: {e}"))?;

    while let Some(row) = iter
        .next()
        .transpose()
        .map_err(|e| format!("CASSANDRA_ROW_DESERIALIZE_FAILED: {e}"))?
    {
        let cells = row
            .columns
            .into_iter()
            .map(cql_value_to_cell)
            .collect::<Vec<_>>();
        rows.push(cells);
    }

    Ok((columns, rows))
}

#[derive(DeserializeRow)]
struct KeyspaceRow {
    keyspace_name: String,
}

#[derive(DeserializeRow)]
struct TableRow {
    table_name: String,
}

#[derive(DeserializeRow)]
struct SchemaColumnRow {
    column_name: String,
    cql_type: String,
    position: i32,
}

#[derive(DeserializeRow)]
struct EstimateRow {
    partitions_count: Option<i64>,
}

#[tauri::command]
pub async fn cassandra_list_keyspaces(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<Vec<String>, String> {
    let conn = cassandra_conn(&state, connection_id)?;
    let (session, default_keyspace) = as_cassandra_session(&conn)?;

    let rows_result = session
        .query_unpaged("SELECT keyspace_name FROM system_schema.keyspaces", &[])
        .await
        .map_err(|e| format!("CASSANDRA_LIST_KEYSPACES_FAILED: {e}"))?
        .into_rows_result()
        .map_err(|e| format!("CASSANDRA_LIST_KEYSPACES_ROWS_FAILED: {e}"))?;

    let mut names: Vec<String> = rows_result
        .rows::<KeyspaceRow>()
        .map_err(|e| format!("CASSANDRA_LIST_KEYSPACES_TYPECHECK_FAILED: {e}"))?
        .filter_map(|r| r.ok().map(|row| row.keyspace_name))
        .collect();

    names.sort();

    if let Some(ks) = default_keyspace
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        if let Some(idx) = names.iter().position(|name| name == &ks) {
            if idx > 0 {
                names.remove(idx);
                names.insert(0, ks);
            }
        }
    }

    Ok(names)
}

#[tauri::command]
pub async fn cassandra_list_tables(
    state: State<'_, AppState>,
    connection_id: Uuid,
    keyspace: Option<String>,
) -> Result<Vec<String>, String> {
    let conn = cassandra_conn(&state, connection_id)?;
    let (session, default_keyspace) = as_cassandra_session(&conn)?;
    let keyspace = normalize_keyspace_arg(keyspace, default_keyspace)?;
    validate_identifier(&keyspace, "KEYSPACE")?;

    let rows_result = session
        .query_unpaged(
            "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
            (&keyspace,),
        )
        .await
        .map_err(|e| format!("CASSANDRA_LIST_TABLES_FAILED: {e}"))?
        .into_rows_result()
        .map_err(|e| format!("CASSANDRA_LIST_TABLES_ROWS_FAILED: {e}"))?;

    let mut names: Vec<String> = rows_result
        .rows::<TableRow>()
        .map_err(|e| format!("CASSANDRA_LIST_TABLES_TYPECHECK_FAILED: {e}"))?
        .filter_map(|r| r.ok().map(|row| row.table_name))
        .collect();

    names.sort();
    Ok(names)
}

async fn load_table_columns(
    session: &scylla::client::session::Session,
    keyspace: &str,
    table: &str,
) -> Result<Vec<ColumnMeta>, String> {
    let rows_result = session
        .query_unpaged(
            "SELECT column_name, type AS cql_type, position FROM system_schema.columns \
             WHERE keyspace_name = ? AND table_name = ?",
            (keyspace, table),
        )
        .await
        .map_err(|e| format!("CASSANDRA_COLUMNS_FAILED: {e}"))?
        .into_rows_result()
        .map_err(|e| format!("CASSANDRA_COLUMNS_ROWS_FAILED: {e}"))?;

    let mut rows: Vec<SchemaColumnRow> = rows_result
        .rows::<SchemaColumnRow>()
        .map_err(|e| format!("CASSANDRA_COLUMNS_TYPECHECK_FAILED: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    rows.sort_by_key(|row| row.position);

    let columns = rows
        .into_iter()
        .map(|row| ColumnMeta {
            name: row.column_name,
            db_type: row.cql_type,
        })
        .collect();

    Ok(columns)
}

async fn estimate_row_count(
    session: &scylla::client::session::Session,
    keyspace: &str,
    table: &str,
) -> u64 {
    let rows_result = match session
        .query_unpaged(
            "SELECT partitions_count FROM system.size_estimates \
             WHERE keyspace_name = ? AND table_name = ?",
            (keyspace, table),
        )
        .await
    {
        Ok(res) => match res.into_rows_result() {
            Ok(rows) => rows,
            Err(_) => return 0,
        },
        Err(_) => return 0,
    };

    let mut iter = match rows_result.rows::<EstimateRow>() {
        Ok(iter) => iter,
        Err(_) => return 0,
    };

    let mut total: i64 = 0;
    while let Some(Ok(row)) = iter.next() {
        if let Some(n) = row.partitions_count {
            total = total.saturating_add(n);
        }
    }

    total.max(0) as u64
}

#[tauri::command]
pub async fn cassandra_table_overview(
    state: State<'_, AppState>,
    connection_id: Uuid,
    keyspace: Option<String>,
    table: String,
) -> Result<CassandraTableOverview, String> {
    let conn = cassandra_conn(&state, connection_id)?;
    let (session, default_keyspace) = as_cassandra_session(&conn)?;
    let keyspace = normalize_keyspace_arg(keyspace, default_keyspace)?;
    validate_identifier(&keyspace, "KEYSPACE")?;
    validate_identifier(&table, "TABLE")?;

    let columns = load_table_columns(&session, &keyspace, &table).await?;
    let row_count = estimate_row_count(&session, &keyspace, &table).await;

    Ok(CassandraTableOverview { columns, row_count })
}

#[tauri::command]
pub async fn cassandra_fetch_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    keyspace: Option<String>,
    table: String,
    limit: Option<u32>,
    offset: Option<u64>,
) -> Result<CassandraQueryResult, String> {
    let conn = cassandra_conn(&state, connection_id)?;
    let (session, default_keyspace) = as_cassandra_session(&conn)?;
    let keyspace = normalize_keyspace_arg(keyspace, default_keyspace)?;
    validate_identifier(&keyspace, "KEYSPACE")?;
    validate_identifier(&table, "TABLE")?;

    let limit = limit.unwrap_or(300).clamp(1, 5_000);
    let offset = offset.unwrap_or(0);

    let columns = load_table_columns(&session, &keyspace, &table).await?;
    if columns.is_empty() {
        return Ok(CassandraQueryResult {
            columns,
            rows: vec![],
            row_count: 0,
        });
    }

    let col_list = columns
        .iter()
        .map(|c| quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");

    let ks = quote_ident(&keyspace);
    let tbl = quote_ident(&table);

    // Cassandra has no OFFSET; skip rows only for small offsets via ALLOW FILTERING-free LIMIT.
    let fetch_limit = if offset > 0 {
        limit.saturating_add(offset.min(u32::MAX as u64) as u32)
    } else {
        limit
    };

    let cql = format!("SELECT {col_list} FROM {ks}.{tbl} LIMIT {fetch_limit}");

    let rows_result = session
        .query_unpaged(cql, &[])
        .await
        .map_err(|e| format!("CASSANDRA_FETCH_ROWS_FAILED: {e}"))?
        .into_rows_result()
        .map_err(|e| format!("CASSANDRA_FETCH_ROWS_RESULT_FAILED: {e}"))?;

    let (out_columns, mut rows) = rows_to_result(rows_result)?;

    if offset > 0 {
        let skip = offset.min(rows.len() as u64) as usize;
        rows = rows.into_iter().skip(skip).take(limit as usize).collect();
    } else {
        rows.truncate(limit as usize);
    }

    let row_count = estimate_row_count(&session, &keyspace, &table).await;

    Ok(CassandraQueryResult {
        columns: if out_columns.is_empty() {
            columns
        } else {
            out_columns
        },
        rows,
        row_count,
    })
}

#[derive(DeserializeRow)]
struct ColumnKindRow {
    column_name: String,
    kind: String,
    position: i32,
}

fn pk_kind_rank(kind: &str) -> u8 {
    match kind {
        "partition_key" => 0,
        "clustering" => 1,
        _ => 255,
    }
}

async fn load_primary_key_columns(
    session: &scylla::client::session::Session,
    keyspace: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let rows_result = session
        .query_unpaged(
            "SELECT column_name, kind, position FROM system_schema.columns \
             WHERE keyspace_name = ? AND table_name = ?",
            (keyspace, table),
        )
        .await
        .map_err(|e| format!("CASSANDRA_PK_COLUMNS_FAILED: {e}"))?
        .into_rows_result()
        .map_err(|e| format!("CASSANDRA_PK_COLUMNS_ROWS_FAILED: {e}"))?;

    let mut rows: Vec<ColumnKindRow> = rows_result
        .rows::<ColumnKindRow>()
        .map_err(|e| format!("CASSANDRA_PK_COLUMNS_TYPECHECK_FAILED: {e}"))?
        .filter_map(|r| r.ok())
        .filter(|row| row.kind == "partition_key" || row.kind == "clustering")
        .collect();

    rows.sort_by(|a, b| {
        pk_kind_rank(&a.kind)
            .cmp(&pk_kind_rank(&b.kind))
            .then(a.position.cmp(&b.position))
    });

    Ok(rows.into_iter().map(|r| r.column_name).collect())
}

async fn load_column_type_map(
    session: &scylla::client::session::Session,
    keyspace: &str,
    table: &str,
) -> Result<HashMap<String, String>, String> {
    let columns = load_table_columns(session, keyspace, table).await?;
    Ok(columns.into_iter().map(|c| (c.name, c.db_type)).collect())
}

fn escape_cql_string(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "''"))
}

fn cql_literal_for_type(cql_type: &str, raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok("NULL".to_string());
    }

    let t = cql_type.to_lowercase();
    if t.contains("text")
        || t.contains("ascii")
        || t.contains("varchar")
        || t.contains("uuid")
        || t.contains("timeuuid")
    {
        return Ok(escape_cql_string(trimmed));
    }
    if t.contains("boolean") || t == "bool" {
        let b = matches!(
            trimmed.to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "t"
        );
        return Ok(if b { "true" } else { "false" }.to_string());
    }

    let is_numeric = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+'));
    if is_numeric {
        return Ok(trimmed.to_string());
    }

    Ok(escape_cql_string(trimmed))
}

#[derive(Debug, Deserialize)]
pub struct CassandraRowUpdate {
    pub pk: HashMap<String, String>,
    pub set: HashMap<String, String>,
}

#[tauri::command]
pub async fn cassandra_primary_key_columns(
    state: State<'_, AppState>,
    connection_id: Uuid,
    keyspace: Option<String>,
    table: String,
) -> Result<Vec<String>, String> {
    let conn = cassandra_conn(&state, connection_id)?;
    let (session, default_keyspace) = as_cassandra_session(&conn)?;
    let keyspace = normalize_keyspace_arg(keyspace, default_keyspace)?;
    validate_identifier(&keyspace, "KEYSPACE")?;
    validate_identifier(&table, "TABLE")?;
    load_primary_key_columns(&session, &keyspace, &table).await
}

#[tauri::command]
pub async fn cassandra_update_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    keyspace: Option<String>,
    table: String,
    updates: Vec<CassandraRowUpdate>,
) -> Result<u32, String> {
    let conn = cassandra_conn(&state, connection_id)?;
    let (session, default_keyspace) = as_cassandra_session(&conn)?;
    let keyspace = normalize_keyspace_arg(keyspace, default_keyspace)?;
    validate_identifier(&keyspace, "KEYSPACE")?;
    validate_identifier(&table, "TABLE")?;

    if updates.is_empty() {
        return Ok(0);
    }

    let pk_cols = load_primary_key_columns(&session, &keyspace, &table).await?;
    if pk_cols.is_empty() {
        return Err("CASSANDRA_PRIMARY_KEY_NOT_FOUND".into());
    }

    let type_map = load_column_type_map(&session, &keyspace, &table).await?;
    let ks = quote_ident(&keyspace);
    let tbl = quote_ident(&table);
    let pk_set: std::collections::HashSet<&str> = pk_cols.iter().map(String::as_str).collect();

    let mut applied = 0u32;
    for update in updates {
        if update.set.is_empty() {
            continue;
        }

        for pk_name in &pk_cols {
            if !update.pk.contains_key(pk_name) {
                return Err(format!("CASSANDRA_PK_VALUE_MISSING: {pk_name}"));
            }
        }

        for col in update.set.keys() {
            validate_identifier(col, "COLUMN")?;
            if pk_set.contains(col.as_str()) {
                return Err(format!("CASSANDRA_PK_COLUMN_IMMUTABLE: {col}"));
            }
        }

        let set_clause = update
            .set
            .iter()
            .map(|(col, val)| {
                let cql_type = type_map.get(col).map(String::as_str).unwrap_or("text");
                let lit = cql_literal_for_type(cql_type, val)?;
                Ok(format!("{} = {lit}", quote_ident(col)))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join(", ");

        let where_clause = pk_cols
            .iter()
            .map(|col| {
                let val = update
                    .pk
                    .get(col)
                    .ok_or_else(|| format!("CASSANDRA_PK_VALUE_MISSING: {col}"))?;
                let cql_type = type_map.get(col).map(String::as_str).unwrap_or("text");
                let lit = cql_literal_for_type(cql_type, val)?;
                Ok(format!("{} = {lit}", quote_ident(col)))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join(" AND ");

        let cql = format!("UPDATE {ks}.{tbl} SET {set_clause} WHERE {where_clause}");
        session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| format!("CASSANDRA_UPDATE_FAILED: {e}"))?;
        applied += 1;
    }

    Ok(applied)
}
