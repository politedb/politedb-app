use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use uuid::Uuid;

/// One shared [`Connection`] per runtime handle.
/// Required for `:memory:` — each `Connection::open(":memory:")` is a separate empty DB.
#[derive(Clone)]
pub struct SqliteConn {
    pub id: Uuid,
    pub label: String,
    /// SQLite path / URI used to open `conn` (e.g. `:memory:`).
    #[allow(dead_code)]
    pub db_path: String,
    pub conn: Arc<Mutex<Connection>>,
    pub default_statement_timeout_ms: Option<u64>,
}
