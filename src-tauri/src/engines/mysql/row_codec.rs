use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use mysql_async::{
    consts::{ColumnFlags, ColumnType},
    Row, Value,
};

use crate::types::{CellValue, ColumnMeta};

#[derive(Clone)]
pub struct ColDecoder {
    pub ty: ColumnType,
    pub character_set: u16,
    pub flags: ColumnFlags,
}

pub fn build_meta_and_decoders_from_columns(
    cols: &[mysql_async::Column],
) -> (Vec<ColumnMeta>, Vec<ColDecoder>) {
    let meta = cols
        .iter()
        .map(|c| ColumnMeta {
            name: c.name_str().to_string(),
            db_type: mysql_column_type_label(c),
        })
        .collect::<Vec<_>>();

    let decoders = cols
        .iter()
        .map(|c| ColDecoder {
            ty: c.column_type(),
            character_set: c.character_set(),
            flags: c.flags(),
        })
        .collect::<Vec<_>>();

    (meta, decoders)
}

pub fn row_to_cells(row: &Row, decoders: &[ColDecoder]) -> Vec<CellValue> {
    let mut out = Vec::with_capacity(decoders.len());
    for (idx, d) in decoders.iter().enumerate() {
        let v = row.as_ref(idx);
        out.push(decode_value(v, d));
    }
    out
}

fn decode_value(v: Option<&Value>, decoder: &ColDecoder) -> CellValue {
    let Some(v) = v else {
        return CellValue::Null;
    };
    let ty = decoder.ty;

    match v {
        Value::NULL => CellValue::Null,

        // mysql_async already parsed numeric binary protocol values
        Value::Int(x) => CellValue::I64(*x),

        Value::UInt(x) => {
            if *x <= i64::MAX as u64 {
                CellValue::I64(*x as i64)
            } else {
                // Avoid overflow in UI; show as string (lossless)
                CellValue::Str(x.to_string())
            }
        }

        Value::Float(x) => CellValue::F64(*x as f64),
        Value::Double(x) => CellValue::F64(*x),

        // MySQL date/datetime/timestamp delivered in structured form here
        Value::Date(y, m, d, hh, mm, ss, micros) => {
            // Distinguish DATE vs DATETIME/TIMESTAMP using column type
            match ty {
                ColumnType::MYSQL_TYPE_DATE => {
                    CellValue::Str(format!("{:04}-{:02}-{:02}", y, m, d))
                }
                ColumnType::MYSQL_TYPE_TIMESTAMP
                | ColumnType::MYSQL_TYPE_DATETIME
                | ColumnType::MYSQL_TYPE_NEWDATE => {
                    // NEWDATE is legacy; treat as datetime-ish representation
                    CellValue::Str(format!(
                        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
                        y, m, d, hh, mm, ss, micros
                    ))
                }
                _ => {
                    // Fallback: keep full precision
                    CellValue::Str(format!(
                        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
                        y, m, d, hh, mm, ss, micros
                    ))
                }
            }
        }

        // MySQL TIME can exceed 24h; represent as [-]HH:MM:SS[.micros] with hours extended
        Value::Time(is_neg, days, hours, minutes, seconds, micros) => {
            let sign = if *is_neg { "-" } else { "" };
            let total_hours: u64 = (*days as u64) * 24 + (*hours as u64);

            // Keep micros always to preserve precision (consistent formatting)
            CellValue::Str(format!(
                "{}{:02}:{:02}:{:02}.{:06}",
                sign, total_hours, minutes, seconds, micros
            ))
        }

        // Everything byte-based (includes strings, decimals, json, blobs, geometry, bit, enum/set, etc.)
        Value::Bytes(b) => decode_bytes(b, decoder),
    }
}

fn decode_bytes(b: &[u8], decoder: &ColDecoder) -> CellValue {
    let ty = decoder.ty;

    // 1) JSON: keep as JSON string when UTF-8, else base64
    if ty == ColumnType::MYSQL_TYPE_JSON {
        return match std::str::from_utf8(b) {
            Ok(s) => CellValue::Json(s.to_string()),
            Err(_) => CellValue::BytesB64(B64.encode(b)),
        };
    }

    // 2) GEOMETRY: binary WKB; do not try to UTF-8
    if ty == ColumnType::MYSQL_TYPE_GEOMETRY {
        return CellValue::BytesB64(B64.encode(b));
    }

    // 3) BIT: MySQL can return packed bits; show as 0/1 string if small, else base64
    if ty == ColumnType::MYSQL_TYPE_BIT {
        // Common UI-friendly representation: interpret as big-endian integer when <= 8 bytes
        if b.len() <= 8 {
            let mut acc: u64 = 0;
            for &x in b {
                acc = (acc << 8) | x as u64;
            }
            return CellValue::Str(acc.to_string());
        }
        return CellValue::BytesB64(B64.encode(b));
    }

    // 4) DECIMAL/NEWDECIMAL use the binary charset in MySQL metadata even
    // though their payload is textual. Decode them before binary detection.
    if matches!(
        ty,
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL
    ) {
        return match std::str::from_utf8(b) {
            Ok(s) => CellValue::Str(s.to_string()),
            Err(_) => CellValue::BytesB64(B64.encode(b)),
        };
    }

    // 5) Binary BLOB/VARBINARY/BINARY: always base64 (avoid corrupting arbitrary binary).
    // MySQL reports TEXT and VARCHAR-like values through byte variants too; only binary
    // charset means opaque bytes.
    if is_binary_bytes(decoder) {
        return CellValue::BytesB64(B64.encode(b));
    }

    // 6) ENUM/SET: returned as string (bytes). Keep UTF-8 else base64.
    if matches!(ty, ColumnType::MYSQL_TYPE_ENUM | ColumnType::MYSQL_TYPE_SET) {
        return match std::str::from_utf8(b) {
            Ok(s) => CellValue::Str(s.to_string()),
            Err(_) => CellValue::BytesB64(B64.encode(b)),
        };
    }

    // 7) YEAR: often returned as bytes depending on protocol/settings; prefer string
    if ty == ColumnType::MYSQL_TYPE_YEAR {
        return match std::str::from_utf8(b) {
            Ok(s) => CellValue::Str(s.to_string()),
            Err(_) => CellValue::BytesB64(B64.encode(b)),
        };
    }

    // 8) TEXT/STRING/VARCHAR/VAR_STRING/CHAR and most other “text-ish”:
    // Try UTF-8; if not, keep bytes base64 (do not lose data).
    match std::str::from_utf8(b) {
        Ok(s) => CellValue::Str(s.to_string()),
        Err(_) => CellValue::BytesB64(B64.encode(b)),
    }
}

#[inline]
fn is_binary_bytes(decoder: &ColDecoder) -> bool {
    const MYSQL_BINARY_CHARSET: u16 = 63;

    decoder.character_set == MYSQL_BINARY_CHARSET
        || (is_blob_type(decoder.ty) && decoder.flags.contains(ColumnFlags::BINARY_FLAG))
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

fn mysql_column_type_label(c: &mysql_async::Column) -> String {
    let ty = c.column_type();
    let raw = format!("{ty:?}");
    let label = raw
        .strip_prefix("MYSQL_TYPE_")
        .unwrap_or(raw.as_str())
        .to_ascii_lowercase();

    if is_blob_type(ty) {
        const MYSQL_BINARY_CHARSET: u16 = 63;
        if c.character_set() == MYSQL_BINARY_CHARSET || c.flags().contains(ColumnFlags::BINARY_FLAG)
        {
            return "blob".to_string();
        }
        return "text".to_string();
    }

    label
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_with_binary_charset_stays_textual() {
        let decoder = ColDecoder {
            ty: ColumnType::MYSQL_TYPE_NEWDECIMAL,
            character_set: 63,
            flags: ColumnFlags::empty(),
        };

        match decode_bytes(b"123.45", &decoder) {
            CellValue::Str(value) => assert_eq!(value, "123.45"),
            other => panic!("expected decimal string, got {other:?}"),
        }
    }

    #[test]
    fn blob_with_binary_charset_stays_base64() {
        let decoder = ColDecoder {
            ty: ColumnType::MYSQL_TYPE_LONG_BLOB,
            character_set: 63,
            flags: ColumnFlags::BINARY_FLAG,
        };

        match decode_bytes(&[0x01, 0x02, 0xff], &decoder) {
            CellValue::BytesB64(value) => assert_eq!(value, "AQL/"),
            other => panic!("expected base64 bytes, got {other:?}"),
        }
    }
}
