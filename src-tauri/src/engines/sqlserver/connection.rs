use uuid::Uuid;

#[derive(Clone)]
pub struct SqlServerConn {
    pub id: Uuid,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub encrypt: bool,
    pub connect_timeout_ms: Option<u64>,
    pub default_statement_timeout_ms: Option<u64>,
}
