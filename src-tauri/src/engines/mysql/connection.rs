use uuid::Uuid;
use crate::types::EngineKind;

#[derive(Clone)]
pub struct MySqlConn {
    pub id: Uuid,
    pub label: String,
    pub engine: EngineKind,
    pub pool: mysql_async::Pool,
    pub default_statement_timeout_ms: Option<u64>,
}
