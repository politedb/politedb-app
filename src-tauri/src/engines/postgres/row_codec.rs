// src-tauri/src/engines/postgres/row_codec.rs
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tokio_postgres::types::Type;
use tokio_postgres::{Row, Statement};

use crate::types::{CellValue, ColumnMeta};

#[derive(Clone, Copy)]
pub enum ColDecoder {
    Bool,
    I16,
    I32,
    I64,
    F32,
    F64,
    Text,
    Json,
    Uuid,
    Bytea,
    FallbackText,
}

impl ColDecoder {
    #[inline]
    pub fn decode(&self, row: &Row, idx: usize) -> CellValue {
        match self {
            ColDecoder::Bool => row
                .try_get::<usize, Option<bool>>(idx)
                .ok()
                .flatten()
                .map(CellValue::Bool)
                .unwrap_or(CellValue::Null),

            ColDecoder::I16 => row
                .try_get::<usize, Option<i16>>(idx)
                .ok()
                .flatten()
                .map(|x| CellValue::I64(x as i64))
                .unwrap_or(CellValue::Null),

            ColDecoder::I32 => row
                .try_get::<usize, Option<i32>>(idx)
                .ok()
                .flatten()
                .map(|x| CellValue::I64(x as i64))
                .unwrap_or(CellValue::Null),

            ColDecoder::I64 => row
                .try_get::<usize, Option<i64>>(idx)
                .ok()
                .flatten()
                .map(CellValue::I64)
                .unwrap_or(CellValue::Null),

            ColDecoder::F32 => row
                .try_get::<usize, Option<f32>>(idx)
                .ok()
                .flatten()
                .map(|x| CellValue::F64(x as f64))
                .unwrap_or(CellValue::Null),

            ColDecoder::F64 => row
                .try_get::<usize, Option<f64>>(idx)
                .ok()
                .flatten()
                .map(CellValue::F64)
                .unwrap_or(CellValue::Null),

            ColDecoder::Text => row
                .try_get::<usize, Option<String>>(idx)
                .ok()
                .flatten()
                .map(CellValue::Str)
                .unwrap_or(CellValue::Null),

            ColDecoder::Json => match row.try_get::<usize, Option<serde_json::Value>>(idx) {
                Ok(Some(j)) => CellValue::Json(j.to_string()),
                Ok(None) => CellValue::Null,
                Err(_) => CellValue::Null,
            },

            ColDecoder::Uuid => row
                .try_get::<usize, Option<uuid::Uuid>>(idx)
                .ok()
                .flatten()
                .map(|u| CellValue::Str(u.to_string()))
                .unwrap_or(CellValue::Null),

            ColDecoder::Bytea => match row.try_get::<usize, Option<Vec<u8>>>(idx) {
                Ok(Some(bytes)) => CellValue::BytesB64(B64.encode(bytes)),
                Ok(None) => CellValue::Null,
                Err(_) => CellValue::Null,
            },

            ColDecoder::FallbackText => row
                .try_get::<usize, Option<String>>(idx)
                .ok()
                .flatten()
                .map(CellValue::Str)
                .unwrap_or(CellValue::Null),
        }
    }
}

#[inline]
fn decoder_for_type(t: &Type) -> ColDecoder {
    match *t {
        Type::BOOL => ColDecoder::Bool,

        Type::INT2 => ColDecoder::I16,
        Type::INT4 => ColDecoder::I32,
        Type::INT8 => ColDecoder::I64,

        Type::FLOAT4 => ColDecoder::F32,
        Type::FLOAT8 => ColDecoder::F64,

        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => ColDecoder::Text,

        Type::JSON | Type::JSONB => ColDecoder::Json,
        Type::UUID => ColDecoder::Uuid,
        Type::BYTEA => ColDecoder::Bytea,

        _ => ColDecoder::FallbackText,
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

    let decoders = cols
        .iter()
        .map(|c| decoder_for_type(c.type_()))
        .collect::<Vec<_>>();

    (meta, decoders)
}

#[inline]
pub fn row_to_cells_with_decoders(row: &Row, decoders: &[ColDecoder]) -> Vec<CellValue> {
    let mut out = Vec::with_capacity(decoders.len());
    for (idx, d) in decoders.iter().enumerate() {
        out.push(d.decode(row, idx));
    }
    out
}
