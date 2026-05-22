use chrono::{DateTime as ChronoDateTime, NaiveDate, NaiveDateTime, Timelike, Utc};
use klickhouse::{Date, DateTime, DynDateTime64, Type, Value as ChValue};

use crate::types::CellValue;

pub fn unwrap_clickhouse_type_str(db_type: &str) -> String {
    let mut t = db_type.trim().to_string();
    for _ in 0..8 {
        let lower = t.to_ascii_lowercase();
        if let Some(inner) = lower.strip_prefix("nullable(") {
            if inner.ends_with(')') {
                t = inner[..inner.len() - 1].trim().to_string();
                continue;
            }
        }
        if let Some(inner) = lower.strip_prefix("lowcardinality(") {
            if inner.ends_with(')') {
                t = inner[..inner.len() - 1].trim().to_string();
                continue;
            }
        }
        break;
    }
    t
}

/// Parse fractional digits from `Decimal(P, S)` / `Decimal64(S)` (after unwrap).
pub fn clickhouse_decimal_scale(db_type: &str) -> Option<usize> {
    let inner = unwrap_clickhouse_type_str(db_type).to_ascii_lowercase();
    if !inner.starts_with("decimal") && !inner.starts_with("fixedpoint") {
        return None;
    }
    if let Some(comma) = inner.rfind(',') {
        if let Some(end) = inner.rfind(')') {
            if comma < end {
                return inner[comma + 1..end].trim().parse().ok();
            }
        }
    }
    if let Some(open) = inner.rfind('(') {
        if let Some(end) = inner.rfind(')') {
            if open < end {
                return inner[open + 1..end].trim().parse().ok();
            }
        }
    }
    None
}

pub fn decimal_scale_from_klick_type(ty: &Type) -> Option<usize> {
    match ty {
        Type::Decimal32(s) | Type::Decimal64(s) | Type::Decimal128(s) | Type::Decimal256(s) => {
            Some(*s)
        }
        _ => None,
    }
}

pub fn clickhouse_decimal_to_cell_i64(raw: i64, scale: usize) -> CellValue {
    if scale == 0 {
        CellValue::I64(raw)
    } else {
        CellValue::F64(raw as f64 / 10_f64.powi(scale as i32))
    }
}

pub fn clickhouse_decimal_to_cell_i128(raw: i128, scale: usize) -> CellValue {
    if scale == 0 {
        CellValue::Str(raw.to_string())
    } else {
        CellValue::F64((raw as f64) / 10_f64.powi(scale as i32))
    }
}

fn decimal_scale_for_column(col_type: Option<&Type>) -> Option<usize> {
    col_type
        .and_then(decimal_scale_from_klick_type)
        .or_else(|| {
            col_type.and_then(|t| clickhouse_decimal_scale(&t.to_string()))
        })
}

pub fn klick_value_to_cell(v: ChValue, col_type: Option<&Type>) -> CellValue {
    if let Some(scale) = decimal_scale_for_column(col_type) {
        if scale > 0 {
            match v {
                ChValue::Decimal32(_, x) => {
                    return clickhouse_decimal_to_cell_i64(i64::from(x), scale);
                }
                ChValue::Decimal64(_, x) => {
                    return clickhouse_decimal_to_cell_i64(x, scale);
                }
                ChValue::Decimal128(_, x) => {
                    return clickhouse_decimal_to_cell_i128(x, scale);
                }
                ChValue::Int8(x) => return clickhouse_decimal_to_cell_i64(x as i64, scale),
                ChValue::Int16(x) => return clickhouse_decimal_to_cell_i64(x as i64, scale),
                ChValue::Int32(x) => return clickhouse_decimal_to_cell_i64(x as i64, scale),
                ChValue::Int64(x) => return clickhouse_decimal_to_cell_i64(x, scale),
                ChValue::UInt8(x) => return clickhouse_decimal_to_cell_i64(x as i64, scale),
                ChValue::UInt16(x) => return clickhouse_decimal_to_cell_i64(x as i64, scale),
                ChValue::UInt32(x) => return clickhouse_decimal_to_cell_i64(x as i64, scale),
                ChValue::UInt64(x) => return clickhouse_decimal_to_cell_i64(x as i64, scale),
                _ => {}
            }
        }
    }

    match v {
        ChValue::Decimal32(_, x) => {
            clickhouse_decimal_to_cell_i64(i64::from(x), 0)
        }
        ChValue::Decimal64(_, x) => clickhouse_decimal_to_cell_i64(x, 0),
        ChValue::Decimal128(_, x) => clickhouse_decimal_to_cell_i128(x, 0),
        ChValue::Decimal256(_, x) => CellValue::Str(x.to_string()),
        ChValue::Null => CellValue::Null,
        ChValue::Int8(x) => CellValue::I64(x as i64),
        ChValue::Int16(x) => CellValue::I64(x as i64),
        ChValue::Int32(x) => CellValue::I64(x as i64),
        ChValue::Int64(x) => CellValue::I64(x),
        ChValue::Int128(x) => CellValue::Str(x.to_string()),
        ChValue::Int256(x) => CellValue::Str(x.to_string()),
        ChValue::UInt8(x) => CellValue::I64(x as i64),
        ChValue::UInt16(x) => CellValue::I64(x as i64),
        ChValue::UInt32(x) => CellValue::I64(x as i64),
        ChValue::UInt64(x) => CellValue::I64(x as i64),
        ChValue::UInt128(x) => CellValue::Str(x.to_string()),
        ChValue::UInt256(x) => CellValue::Str(x.to_string()),
        ChValue::Float32(x) => CellValue::F64(x as f64),
        ChValue::Float64(x) => CellValue::F64(x),
        ChValue::String(bytes) => CellValue::Str(String::from_utf8_lossy(&bytes).into_owned()),
        ChValue::Uuid(u) => CellValue::Str(u.to_string()),
        ChValue::Date(d) => CellValue::Str(format_clickhouse_date(d)),
        ChValue::DateTime(dt) => CellValue::Str(format_clickhouse_datetime(dt)),
        ChValue::DateTime64(dt) => CellValue::Str(format_clickhouse_datetime64(dt)),
        ChValue::Enum8(x) => CellValue::I64(x as i64),
        ChValue::Enum16(x) => CellValue::I64(x as i64),
        ChValue::Array(arr) | ChValue::Tuple(arr) => {
            let cells: Vec<CellValue> = arr
                .into_iter()
                .map(|v| klick_value_to_cell(v, None))
                .collect();
            CellValue::Json(serde_json::to_string(&cells).unwrap_or_else(|_| "[]".to_string()))
        }
        ChValue::Map(keys, values) => {
            CellValue::Json(format!("{{keys:{keys:?},values:{values:?}}}"))
        }
        other => CellValue::Str(other.to_string()),
    }
}

fn format_naive_datetime(dt: NaiveDateTime) -> String {
    if dt.nanosecond() > 0 {
        dt.format("%Y-%m-%d %H:%M:%S%.f").to_string()
    } else {
        dt.format("%Y-%m-%d %H:%M:%S").to_string()
    }
}

pub fn format_clickhouse_date(d: Date) -> String {
    let naive: NaiveDate = d.into();
    naive.format("%Y-%m-%d").to_string()
}

pub fn format_clickhouse_datetime(dt: DateTime) -> String {
    match ChronoDateTime::<Utc>::try_from(dt) {
        Ok(utc) => format_naive_datetime(utc.naive_utc()),
        Err(_) => format!("{dt:?}"),
    }
}

pub fn format_clickhouse_datetime64(dt: DynDateTime64) -> String {
    match ChronoDateTime::<Utc>::try_from(dt) {
        Ok(utc) => format_naive_datetime(utc.naive_utc()),
        Err(_) => format!("{dt:?}"),
    }
}
