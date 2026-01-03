use serde_json::Value;
use tokio_postgres::types::Type;
use tokio_postgres::Row;

pub fn column_type_name(t: &Type) -> String {
    t.name().to_string()
}

pub fn row_to_json_vec(row: &Row) -> Vec<Value> {
    let mut out = Vec::with_capacity(row.len());

    for (idx, col) in row.columns().iter().enumerate() {
        let t = col.type_();

        let v = match *t {
            Type::BOOL => row
                .try_get::<usize, bool>(idx)
                .map(Value::Bool)
                .unwrap_or(Value::Null),

            Type::INT2 => row
                .try_get::<usize, i16>(idx)
                .map(|x| Value::Number(x.into()))
                .unwrap_or(Value::Null),
            Type::INT4 => row
                .try_get::<usize, i32>(idx)
                .map(|x| Value::Number(x.into()))
                .unwrap_or(Value::Null),
            Type::INT8 => row
                .try_get::<usize, i64>(idx)
                .ok()
                .map(Value::from)
                .unwrap_or(Value::Null),

            Type::FLOAT4 => row
                .try_get::<usize, f32>(idx)
                .ok()
                .and_then(|x| serde_json::Number::from_f64(x as f64).map(Value::Number))
                .unwrap_or(Value::Null),
            Type::FLOAT8 => row
                .try_get::<usize, f64>(idx)
                .ok()
                .and_then(|x| serde_json::Number::from_f64(x).map(Value::Number))
                .unwrap_or(Value::Null),

            Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => row
                .try_get::<usize, String>(idx)
                .map(Value::String)
                .unwrap_or(Value::Null),

            Type::JSON | Type::JSONB => row
                .try_get::<usize, serde_json::Value>(idx)
                .unwrap_or(Value::Null),

            Type::UUID => row
                .try_get::<usize, uuid::Uuid>(idx)
                .map(|u| Value::String(u.to_string()))
                .unwrap_or(Value::Null),

            _ => {
                // Fallback: cố gắng lấy String; nếu không được thì Null.
                row.try_get::<usize, String>(idx)
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            }
        };

        out.push(v);
    }

    out
}
