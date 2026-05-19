use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct D1Conn {
    pub id: Uuid,
    pub label: String,
    pub account_id: String,
    pub database_id: String,
    pub api_token: String,
    pub api_base: String,
    pub default_statement_timeout_ms: Option<u64>,
    pub http: Arc<reqwest::Client>,
}
