use std::sync::{Arc, Mutex};

use crate::file_access::Leased;

use duckdb::Connection;
use uuid::Uuid;

pub type SharedDuckdb = Arc<Leased<Mutex<Connection>>>;

#[derive(Clone)]
pub struct DuckdbConn {
    pub id: Uuid,
    pub label: String,
    pub db_path: String,
    /// See `SqliteConn::conn`: the lease outlives the connection's final close.
    pub conn: SharedDuckdb,
    pub default_statement_timeout_ms: Option<u64>,
}
