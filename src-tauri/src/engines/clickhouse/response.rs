use crate::types::CellValue;

#[derive(Debug, Clone)]
pub(crate) struct ChJsonMeta {
    pub name: String,
    pub db_type: String,
}

#[derive(Debug)]
pub(crate) struct ChJsonResponse {
    pub meta: Option<Vec<ChJsonMeta>>,
    pub data: Option<Vec<Vec<CellValue>>>,
    pub rows: Option<u64>,
}
