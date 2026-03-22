use uuid::Uuid;

#[derive(Clone)]
pub struct SqliteConn {
    pub id: Uuid,
    pub label: String,
    pub db_path: String,
    pub default_statement_timeout_ms: Option<u64>,
}
