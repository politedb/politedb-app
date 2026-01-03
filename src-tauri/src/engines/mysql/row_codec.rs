use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use mysql_async::{consts::ColumnType, Row, Value};

use crate::types::{CellValue, ColumnMeta};

#[derive(Clone)]
pub struct ColDecoder {
    pub ty: ColumnType,
}

pub fn build_meta_and_decoders_from_columns(
    cols: &[mysql_async::Column],
) -> (Vec<ColumnMeta>, Vec<ColDecoder>) {
    let meta = cols
        .iter()
        .map(|c| ColumnMeta {
            name: c.name_str().to_string(),
            db_type: format!("{:?}", c.column_type()),
        })
        .collect::<Vec<_>>();

    let decoders = cols
        .iter()
        .map(|c| ColDecoder {
            ty: c.column_type(),
        })
        .collect::<Vec<_>>();

    (meta, decoders)
}

pub fn row_to_cells(row: &Row, decoders: &[ColDecoder]) -> Vec<CellValue> {
    let mut out = Vec::with_capacity(decoders.len());
    for (idx, d) in decoders.iter().enumerate() {
        let v = row.as_ref(idx);
        out.push(decode_value(v, d.ty));
    }
    out
}

fn decode_value(v: Option<&Value>, ty: ColumnType) -> CellValue {
    let Some(v) = v else {
        return CellValue::Null;
    };

    match v {
        Value::NULL => CellValue::Null,
        Value::Int(x) => CellValue::I64(*x),
        Value::UInt(x) => {
            if *x <= i64::MAX as u64 {
                CellValue::I64(*x as i64)
            } else {
                CellValue::Str(x.to_string())
            }
        }
        Value::Float(x) => CellValue::F64(*x as f64),
        Value::Double(x) => CellValue::F64(*x),

        Value::Date(y, m, d, hh, mm, ss, micros) => CellValue::Str(format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
            y, m, d, hh, mm, ss, micros
        )),

        Value::Time(is_neg, days, hours, minutes, seconds, micros) => {
            let sign = if *is_neg { "-" } else { "" };
            CellValue::Str(format!(
                "{}{} {:02}:{:02}:{:02}.{:06}",
                sign, days, hours, minutes, seconds, micros
            ))
        }

        Value::Bytes(b) => {
            if ty == ColumnType::MYSQL_TYPE_JSON {
                return match std::str::from_utf8(b) {
                    Ok(s) => CellValue::Json(s.to_string()),
                    Err(_) => CellValue::BytesB64(B64.encode(b)),
                };
            }

            if is_blob_type(ty) {
                return CellValue::BytesB64(B64.encode(b));
            }

            match std::str::from_utf8(b) {
                Ok(s) => CellValue::Str(s.to_string()),
                Err(_) => CellValue::BytesB64(B64.encode(b)),
            }
        }
    }
}

#[inline]
fn is_blob_type(ty: ColumnType) -> bool {
    matches!(
        ty,
        ColumnType::MYSQL_TYPE_BLOB
            | ColumnType::MYSQL_TYPE_LONG_BLOB
            | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
            | ColumnType::MYSQL_TYPE_TINY_BLOB
    )
}
