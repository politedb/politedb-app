use std::sync::{Arc, Mutex};

use crate::file_access::Leased;

use rusqlite::Connection;
use uuid::Uuid;

pub type SharedSqlite = Arc<Leased<Mutex<Connection>>>;

/// One shared [`Connection`] per runtime handle.
/// Required for `:memory:` — each `Connection::open(":memory:")` is a separate empty DB.
#[derive(Clone)]
pub struct SqliteConn {
    pub id: Uuid,
    pub label: String,
    /// SQLite path / URI used to open `conn` (e.g. `:memory:`).
    #[allow(dead_code)]
    pub db_path: String,
    /// Shared by every clone (queries, exports); the file-access lease inside is
    /// released only after the last user drops it and the connection has closed.
    pub conn: SharedSqlite,
    pub default_statement_timeout_ms: Option<u64>,
}
