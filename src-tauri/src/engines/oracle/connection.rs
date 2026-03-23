use uuid::Uuid;

#[derive(Clone)]
pub struct OracleConn {
    pub id: Uuid,
    pub label: String,
    pub connect_string: String,
    pub user: String,
    pub password: String,
    pub default_statement_timeout_ms: Option<u64>,
}
