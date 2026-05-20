use std::sync::{Arc, Mutex};

use duckdb::Connection;
use uuid::Uuid;

#[derive(Clone)]
pub struct DuckdbConn {
    pub id: Uuid,
    pub label: String,
    pub db_path: String,
    pub conn: Arc<Mutex<Connection>>,
    pub default_statement_timeout_ms: Option<u64>,
}
