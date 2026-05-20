use uuid::Uuid;

#[derive(Clone)]
pub struct SnowflakeConn {
    pub id: Uuid,
    pub label: String,
    pub account: String,
    pub warehouse: String,
    pub database: String,
    pub schema: String,
    pub role: Option<String>,
    pub user: String,
    pub password: String,
    pub connect_timeout_ms: Option<u64>,
    pub default_statement_timeout_ms: Option<u64>,
}
