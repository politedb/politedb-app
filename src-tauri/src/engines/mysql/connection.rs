use uuid::Uuid;

#[derive(Clone)]
pub struct MySqlConn {
    pub id: Uuid,
    pub label: String,
    pub pool: mysql_async::Pool,
    pub default_statement_timeout_ms: Option<u64>,
}
