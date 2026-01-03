use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub db_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum CellValue {
    Null,
    Bool(bool),
    I64(i64),
    F64(f64),
    Str(String),
    Json(String),
    BytesB64(String),
}
