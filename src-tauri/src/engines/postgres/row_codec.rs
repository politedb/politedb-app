use crate::types::{CellValue, ColumnMeta};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::FixedOffset;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime};
use std::net::IpAddr;
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{Row, Statement};

#[derive(Clone, Copy)]
pub enum ColDecoder {
    // Scalars
    Bool,
    I16,
    I32,
    I64,
    F32,
    F64,

    // Text-ish
    Text,
    Json,
    Uuid,

    // Binary
    Bytea,

    // Date/Time
    DateText,
    TimeText,
    TimetzText,
    TimestampText,
    TimestamptzText,
    IntervalText,

    // Numeric / Money
    NumericText,
    MoneyText,

    // Network
    Inet,
    CidrText,
    MacaddrText,
    Macaddr8Text,

    // Misc text
    XmlText,
    TsvectorText,
    TsqueryText,
    JsonPathText,

    // Oid
    Oid,

    // Arrays (typed where safe)
    BoolArray,
    I16Array,
    I32Array,
    I64Array,
    F32Array,
    F64Array,
    TextArray,
    UuidArray,
    JsonArray,
    ByteaArray,

    // Arrays we keep as TEXT for compatibility / lossless
    NumericArrayText,
    DateArrayText,
    TimestampArrayText,
    TimestamptzArrayText,

    // Ranges / composite / user-defined => TEXT
    RangeText,

    // Catch-all
    Fallback,
}

impl ColDecoder {
    #[inline]
    pub fn decode(&self, row: &Row, idx: usize) -> CellValue {
        match self {
            // scalars
            ColDecoder::Bool => opt(row, idx, CellValue::Bool),
            ColDecoder::I16 => opt(row, idx, |v: i16| CellValue::I64(v as i64)),
            ColDecoder::I32 => opt(row, idx, |v: i32| CellValue::I64(v as i64)),
            ColDecoder::I64 => opt(row, idx, CellValue::I64),
            ColDecoder::F32 => opt(row, idx, |v: f32| CellValue::F64(v as f64)),
            ColDecoder::F64 => opt(row, idx, CellValue::F64),

            // text-ish
            ColDecoder::Text => opt(row, idx, CellValue::Str),

            ColDecoder::Json => match row.try_get::<usize, Option<serde_json::Value>>(idx) {
                Ok(Some(v)) => CellValue::Json(v.to_string()),
                Ok(None) => CellValue::Null,
                Err(_) => fallback_to_text_or_bytes(row, idx),
            },

            ColDecoder::Uuid => match row.try_get::<usize, Option<uuid::Uuid>>(idx) {
                Ok(Some(v)) => CellValue::Str(v.to_string()),
                Ok(None) => CellValue::Null,
                Err(_) => fallback_to_text_or_bytes(row, idx),
            },

            // bytes
            ColDecoder::Bytea => match row.try_get::<usize, Option<Vec<u8>>>(idx) {
                Ok(Some(v)) => CellValue::BytesB64(B64.encode(v)),
                Ok(None) => CellValue::Null,
                Err(_) => fallback_to_text_or_bytes(row, idx),
            },

            // date/time
            ColDecoder::DateText => match row.try_get::<usize, Option<NaiveDate>>(idx) {
                Ok(Some(v)) => CellValue::Str(v.to_string()),
                Ok(None) => CellValue::Null,
                Err(_) => fallback_to_text_or_bytes(row, idx),
            },

            ColDecoder::TimeText => match row.try_get::<usize, Option<NaiveTime>>(idx) {
                Ok(Some(v)) => CellValue::Str(v.to_string()),
                Ok(None) => CellValue::Null,
                Err(_) => fallback_to_text_or_bytes(row, idx),
            },

            ColDecoder::TimestampText => match row.try_get::<usize, Option<NaiveDateTime>>(idx) {
                Ok(Some(v)) => CellValue::Str(v.to_string()),
                Ok(None) => CellValue::Null,
                Err(_) => fallback_to_text_or_bytes(row, idx),
            },

            ColDecoder::TimestamptzText => {
                match row.try_get::<usize, Option<DateTime<FixedOffset>>>(idx) {
                    Ok(Some(v)) => CellValue::Str(v.to_rfc3339()),
                    Ok(None) => CellValue::Null,
                    Err(_) => fallback_to_text_or_bytes(row, idx),
                }
            }

            // interval/timetz: keep as text/b64
            ColDecoder::TimetzText | ColDecoder::IntervalText => {
                fallback_to_text_or_bytes(row, idx)
            }

            // money: keep as text/b64
            ColDecoder::MoneyText => fallback_to_text_or_bytes(row, idx),

            // numeric: decode via rust_decimal -> string (when engine-postgres + rust_decimal)
            ColDecoder::NumericText => decode_numeric(row, idx),

            // network
            ColDecoder::Inet => opt(row, idx, |v: IpAddr| CellValue::Str(v.to_string())),
            ColDecoder::CidrText | ColDecoder::MacaddrText | ColDecoder::Macaddr8Text => {
                fallback_to_text_or_bytes(row, idx)
            }

            // misc text
            ColDecoder::XmlText
            | ColDecoder::TsvectorText
            | ColDecoder::TsqueryText
            | ColDecoder::JsonPathText => fallback_to_text_or_bytes(row, idx),

            // oid
            ColDecoder::Oid => opt(row, idx, |v: u32| CellValue::I64(v as i64)),

            // arrays typed where safe
            ColDecoder::BoolArray => opt_array(row, idx, CellValue::Bool),
            ColDecoder::I16Array => opt_array(row, idx, |v: i16| CellValue::I64(v as i64)),
            ColDecoder::I32Array => opt_array(row, idx, |v: i32| CellValue::I64(v as i64)),
            ColDecoder::I64Array => opt_array(row, idx, CellValue::I64),
            ColDecoder::F32Array => opt_array(row, idx, |v: f32| CellValue::F64(v as f64)),
            ColDecoder::F64Array => opt_array(row, idx, CellValue::F64),
            ColDecoder::TextArray => opt_array(row, idx, CellValue::Str),

            ColDecoder::UuidArray => {
                match row.try_get::<usize, Option<Vec<Option<uuid::Uuid>>>>(idx) {
                    Ok(Some(arr)) => json_array(arr.into_iter().map(|x| x.map(|v| v.to_string()))),
                    Ok(None) => CellValue::Null,
                    Err(_) => fallback_to_text_or_bytes(row, idx),
                }
            }

            ColDecoder::JsonArray => {
                match row.try_get::<usize, Option<Vec<Option<serde_json::Value>>>>(idx) {
                    Ok(Some(arr)) => json_array(arr.into_iter().map(|x| x.map(|v| v.to_string()))),
                    Ok(None) => CellValue::Null,
                    Err(_) => fallback_to_text_or_bytes(row, idx),
                }
            }

            ColDecoder::ByteaArray => match row.try_get::<usize, Option<Vec<Option<Vec<u8>>>>>(idx)
            {
                Ok(Some(arr)) => json_array(arr.into_iter().map(|x| x.map(|v| B64.encode(v)))),
                Ok(None) => CellValue::Null,
                Err(_) => fallback_to_text_or_bytes(row, idx),
            },

            // arrays kept as TEXT for compatibility / lossless
            ColDecoder::NumericArrayText
            | ColDecoder::DateArrayText
            | ColDecoder::TimestampArrayText
            | ColDecoder::TimestamptzArrayText => fallback_to_text_or_bytes(row, idx),

            // ranges => TEXT
            ColDecoder::RangeText => fallback_to_text_or_bytes(row, idx),

            ColDecoder::Fallback => fallback_to_text_or_bytes(row, idx),
        }
    }
}

#[inline]
fn decode_numeric(row: &Row, idx: usize) -> CellValue {
    #[cfg(feature = "engine-postgres")]
    {
        use rust_decimal::Decimal;
        match row.try_get::<usize, Option<Decimal>>(idx) {
            Ok(Some(v)) => CellValue::Str(v.to_string()),
            Ok(None) => CellValue::Null,
            Err(_) => fallback_to_text_or_bytes(row, idx),
        }
    }

    #[cfg(not(feature = "engine-postgres"))]
    {
        fallback_to_text_or_bytes(row, idx)
    }
}

#[inline]
fn opt<T, F>(row: &Row, idx: usize, map: F) -> CellValue
where
    for<'a> T: FromSql<'a>,
    F: FnOnce(T) -> CellValue,
{
    match row.try_get::<usize, Option<T>>(idx) {
        Ok(Some(v)) => map(v),
        Ok(None) => CellValue::Null,
        Err(_) => fallback_to_text_or_bytes(row, idx),
    }
}

#[inline]
fn opt_array<T, F>(row: &Row, idx: usize, map: F) -> CellValue
where
    for<'a> T: FromSql<'a>,
    F: Fn(T) -> CellValue + Copy,
{
    match row.try_get::<usize, Option<Vec<Option<T>>>>(idx) {
        Ok(Some(arr)) => {
            let values = arr
                .into_iter()
                .map(|x| match x {
                    Some(v) => cell_to_json(map(v)),
                    None => serde_json::Value::Null,
                })
                .collect::<Vec<_>>();

            CellValue::Json(serde_json::Value::Array(values).to_string())
        }
        Ok(None) => CellValue::Null,
        Err(_) => fallback_to_text_or_bytes(row, idx),
    }
}

#[inline]
fn json_array<I, T>(iter: I) -> CellValue
where
    I: Iterator<Item = Option<T>>,
    T: ToString,
{
    let values = iter
        .map(|x| {
            x.map(|v| serde_json::Value::String(v.to_string()))
                .unwrap_or(serde_json::Value::Null)
        })
        .collect::<Vec<_>>();

    CellValue::Json(serde_json::Value::Array(values).to_string())
}

#[inline]
fn cell_to_json(c: CellValue) -> serde_json::Value {
    match c {
        CellValue::Null => serde_json::Value::Null,
        CellValue::Bool(v) => serde_json::Value::Bool(v),
        CellValue::I64(v) => serde_json::Value::Number(v.into()),
        CellValue::F64(v) => serde_json::Number::from_f64(v)
            .map(serde_json::Value::Number)
            .unwrap_or_else(|| serde_json::Value::String(v.to_string())),
        CellValue::Str(v) => serde_json::Value::String(v),
        CellValue::Json(v) => serde_json::Value::String(v),
        CellValue::BytesB64(v) => serde_json::Value::String(v),
    }
}

#[inline]
fn fallback_to_text_or_bytes(row: &Row, idx: usize) -> CellValue {
    // 1) Prefer TEXT representation (works for many enums/domains/extensions/ranges)
    match row.try_get::<usize, Option<String>>(idx) {
        Ok(Some(s)) => return CellValue::Str(s),
        Ok(None) => return CellValue::Null,
        Err(_) => {}
    }

    // 2) JSON-ish
    if let Ok(Some(j)) = row.try_get::<usize, Option<serde_json::Value>>(idx) {
        return CellValue::Json(j.to_string());
    }

    // 3) Last-resort: bytes base64
    match row.try_get::<usize, Option<Vec<u8>>>(idx) {
        Ok(Some(b)) => CellValue::BytesB64(B64.encode(b)),
        Ok(None) => CellValue::Null,
        Err(_) => CellValue::Null,
    }
}

#[inline]
fn decoder_for_type(t: &Type) -> ColDecoder {
    match *t {
        // scalars
        Type::BOOL => ColDecoder::Bool,
        Type::INT2 => ColDecoder::I16,
        Type::INT4 => ColDecoder::I32,
        Type::INT8 => ColDecoder::I64,
        Type::FLOAT4 => ColDecoder::F32,
        Type::FLOAT8 => ColDecoder::F64,

        // numeric/money
        Type::NUMERIC => ColDecoder::NumericText,
        Type::MONEY => ColDecoder::MoneyText,

        // text-ish
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => ColDecoder::Text,
        Type::JSON | Type::JSONB => ColDecoder::Json,
        Type::UUID => ColDecoder::Uuid,
        Type::BYTEA => ColDecoder::Bytea,

        // date/time
        Type::DATE => ColDecoder::DateText,
        Type::TIME => ColDecoder::TimeText,
        Type::TIMETZ => ColDecoder::TimetzText,
        Type::TIMESTAMP => ColDecoder::TimestampText,
        Type::TIMESTAMPTZ => ColDecoder::TimestamptzText,
        Type::INTERVAL => ColDecoder::IntervalText,

        // network
        Type::INET => ColDecoder::Inet,
        Type::CIDR => ColDecoder::CidrText,
        Type::MACADDR => ColDecoder::MacaddrText,
        Type::MACADDR8 => ColDecoder::Macaddr8Text,

        // misc text
        Type::XML => ColDecoder::XmlText,
        Type::TS_VECTOR => ColDecoder::TsvectorText,
        Type::TSQUERY => ColDecoder::TsqueryText, // ✅ correct constant name
        Type::JSONPATH => ColDecoder::JsonPathText,

        // oid
        Type::OID => ColDecoder::Oid,

        // arrays typed where safe
        Type::BOOL_ARRAY => ColDecoder::BoolArray,
        Type::INT2_ARRAY => ColDecoder::I16Array,
        Type::INT4_ARRAY => ColDecoder::I32Array,
        Type::INT8_ARRAY => ColDecoder::I64Array,
        Type::FLOAT4_ARRAY => ColDecoder::F32Array,
        Type::FLOAT8_ARRAY => ColDecoder::F64Array,

        Type::TEXT_ARRAY | Type::VARCHAR_ARRAY | Type::BPCHAR_ARRAY | Type::NAME_ARRAY => {
            ColDecoder::TextArray
        }
        Type::UUID_ARRAY => ColDecoder::UuidArray,
        Type::JSON_ARRAY | Type::JSONB_ARRAY => ColDecoder::JsonArray,
        Type::BYTEA_ARRAY => ColDecoder::ByteaArray,

        // arrays kept as text for compatibility (lossless)
        Type::NUMERIC_ARRAY => ColDecoder::NumericArrayText,
        Type::DATE_ARRAY => ColDecoder::DateArrayText,
        Type::TIMESTAMP_ARRAY => ColDecoder::TimestampArrayText,
        Type::TIMESTAMPTZ_ARRAY => ColDecoder::TimestamptzArrayText,

        // ranges -> TEXT
        Type::INT4_RANGE
        | Type::INT8_RANGE
        | Type::NUM_RANGE
        | Type::TS_RANGE
        | Type::TSTZ_RANGE
        | Type::DATE_RANGE => ColDecoder::RangeText,

        _ => ColDecoder::Fallback,
    }
}

pub fn column_type_name(t: &Type) -> String {
    t.name().to_string()
}

// Build meta + decoders ONCE per statement
pub fn build_meta_and_decoders(stmt: &Statement) -> (Vec<ColumnMeta>, Vec<ColDecoder>) {
    let cols = stmt.columns();

    let meta = cols
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            db_type: column_type_name(c.type_()),
        })
        .collect::<Vec<_>>();

    let decoders = cols.iter().map(|c| decoder_for_type(c.type_())).collect();

    (meta, decoders)
}

#[inline]
pub fn row_to_cells_with_decoders(row: &Row, decoders: &[ColDecoder]) -> Vec<CellValue> {
    let mut out = Vec::with_capacity(decoders.len());
    for (i, d) in decoders.iter().enumerate() {
        out.push(d.decode(row, i));
    }
    out
}
