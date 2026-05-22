use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct TursoConn {
    pub id: Uuid,
    pub label: String,
    pub db: Arc<libsql::Database>,
    pub default_statement_timeout_ms: Option<u64>,
}
