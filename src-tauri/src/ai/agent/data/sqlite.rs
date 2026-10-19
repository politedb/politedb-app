//! SQLite data executor: a separate connection opened read-only (no URI parsing) with
//! `PRAGMA query_only`, used for one call and closed. A watcher interrupts it on cancel
//! or timeout, repeating until the worker is done.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use serde_json::{Map, Value};

use super::{
    clip_value, short_error, DataExecutor, Rows, DATA_TIMEOUT, MAX_CELL_CHARS, MAX_COLUMNS,
    MAX_PLAN_CHARS,
};
use crate::ai::agent::catalog::{INTERRUPT_GRACE, UNWIND_GRACE};
use crate::ai::agent::query_guard::GuardDialect;
use crate::ai::agent::run::ToolContext;

const INTERRUPT_EVERY: Duration = Duration::from_millis(20);

pub struct SqliteData {
    path: PathBuf,
    timeout: Duration,
}

impl SqliteData {
    /// `None` for in-memory databases and URI paths: a second connection would not see
    /// the same data.
    pub fn for_path(path: &str) -> Option<Self> {
        let path = path.trim();
        if path.is_empty() || path == ":memory:" || path.to_ascii_lowercase().starts_with("file:") {
            return None;
        }
        Some(Self {
            path: PathBuf::from(path),
            timeout: DATA_TIMEOUT,
        })
    }

    /// Opens a read-only connection and runs `work` on a blocking thread, interrupted on
    /// cancel or timeout.
    async fn with_connection<T: Send + 'static>(
        &self,
        ctx: &ToolContext,
        work: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        if ctx.cancel.is_cancelled() {
            return Err("canceled".into());
        }
        let path = self.path.clone();
        let timeout = self.timeout;
        let handle: Arc<Mutex<Option<InterruptHandle>>> = Arc::new(Mutex::new(None));
        let finished = Arc::new(AtomicBool::new(false));
        let done = ctx.cancel.child_token();

        let (watch_handle, watch_finished, watch_done) =
            (handle.clone(), finished.clone(), done.clone());
        ctx.tracker.spawn(async move {
            tokio::select! {
                _ = watch_done.cancelled() => {}
                _ = tokio::time::sleep(timeout) => {}
            }
            let until = Instant::now() + INTERRUPT_GRACE + UNWIND_GRACE;
            while !watch_finished.load(Ordering::SeqCst) && Instant::now() < until {
                if let Some(h) = watch_handle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                {
                    h.interrupt();
                }
                tokio::time::sleep(INTERRUPT_EVERY).await;
            }
        });

        let cancel = ctx.cancel.clone();
        let result = ctx
            .tracker
            .spawn_blocking(move || {
                let outcome = (|| {
                    let conn = Connection::open_with_flags(
                        &path,
                        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                    )
                    .map_err(|_| "could not open the database read-only".to_string())?;
                    conn.pragma_update(None, "query_only", true)
                        .map_err(|_| "could not make the connection read-only".to_string())?;
                    let _ = conn.busy_timeout(Duration::from_secs(1));
                    *handle.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(conn.get_interrupt_handle());
                    if cancel.is_cancelled() {
                        return Err("canceled".to_string());
                    }
                    let result = work(&conn);
                    *handle.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    result
                })();
                finished.store(true, Ordering::SeqCst);
                outcome
            })
            .await
            .map_err(|_| "query failed".to_string())?;
        done.cancel();
        result
    }
}

/// A cell as JSON. Text is cut from SQLite's own buffer before it is copied.
fn to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(bytes) => {
            // A UTF-8 char is at most 4 bytes; one extra char marks the cut.
            let prefix = &bytes[..bytes.len().min((MAX_CELL_CHARS + 1) * 4)];
            clip_value(Value::String(String::from_utf8_lossy(prefix).into_owned()))
        }
        ValueRef::Blob(bytes) => Value::String(format!("<blob {} bytes>", bytes.len())),
    }
}

fn sqlite_error(e: rusqlite::Error) -> String {
    match e.sqlite_error_code() {
        Some(rusqlite::ErrorCode::OperationInterrupted) => "query stopped".to_string(),
        _ => short_error(&e.to_string()),
    }
}

#[async_trait]
impl DataExecutor for SqliteData {
    fn dialect(&self) -> GuardDialect {
        GuardDialect::Sqlite
    }

    async fn query(&self, sql: &str, limit: usize, ctx: &ToolContext) -> Result<Rows, String> {
        let sql = sql.to_string();
        self.with_connection(ctx, move |conn| {
            let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
            // Belt and braces after `query_only`: SQLite itself says it cannot write.
            if !stmt.readonly() {
                return Err("query failed: not a read-only statement".into());
            }
            let names: Vec<String> = stmt
                .column_names()
                .iter()
                .take(MAX_COLUMNS)
                .map(|s| s.to_string())
                .collect();
            let mut rows = stmt.query([]).map_err(sqlite_error)?;
            let mut out = Vec::new();
            let mut truncated = false;
            while let Some(row) = rows.next().map_err(sqlite_error)? {
                if out.len() == limit {
                    truncated = true;
                    break;
                }
                let mut object = Map::new();
                for (i, name) in names.iter().enumerate() {
                    let value = row.get_ref(i).map(to_json).unwrap_or(Value::Null);
                    object.insert(name.clone(), clip_value(value));
                }
                out.push(Value::Object(object));
            }
            Ok(Rows {
                rows: out,
                truncated,
            })
        })
        .await
    }

    async fn explain(&self, sql: &str, ctx: &ToolContext) -> Result<String, String> {
        let sql = format!("EXPLAIN QUERY PLAN {sql}");
        self.with_connection(ctx, move |conn| {
            let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
            let lines = stmt
                .query_map([], |row| row.get::<_, String>(3))
                .map_err(sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sqlite_error)?;
            Ok(lines.join("\n").chars().take(MAX_PLAN_CHARS).collect())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    fn ctx() -> ToolContext {
        ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        }
    }

    fn database() -> (tempfile_path::TempDb, SqliteData) {
        let db = tempfile_path::TempDb::new();
        let conn = Connection::open(&db.path).unwrap();
        conn.execute_batch(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, note TEXT, data BLOB);
             INSERT INTO orders (note, data) VALUES ('a', x'0102'), ('b', NULL), ('c', NULL);",
        )
        .unwrap();
        let exec = SqliteData::for_path(db.path.to_str().unwrap()).unwrap();
        (db, exec)
    }

    mod tempfile_path {
        pub struct TempDb {
            pub path: std::path::PathBuf,
        }
        impl TempDb {
            pub fn new() -> Self {
                let path = std::env::temp_dir()
                    .join(format!("politedb-agent-{}.db", uuid::Uuid::new_v4()));
                Self { path }
            }
        }
        impl Drop for TempDb {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }

    #[test]
    fn memory_and_uri_databases_have_no_data_tools() {
        for path in ["", " ", ":memory:", "file:x.db?mode=rwc", "FILE:/tmp/x"] {
            assert!(SqliteData::for_path(path).is_none(), "{path}");
        }
    }

    #[tokio::test]
    async fn reads_rows_with_a_cap() {
        let (_db, exec) = database();
        let rows = exec
            .query("SELECT id, note, data FROM orders ORDER BY id", 2, &ctx())
            .await
            .unwrap();
        assert!(rows.truncated);
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0]["note"], "a");
        assert_eq!(rows.rows[0]["data"], "<blob 2 bytes>");
        let plan = exec
            .explain("SELECT * FROM orders WHERE id = 1", &ctx())
            .await
            .unwrap();
        assert!(plan.to_ascii_uppercase().contains("ORDERS"));
    }

    #[tokio::test]
    async fn the_connection_cannot_write() {
        let (db, exec) = database();
        for sql in [
            "DELETE FROM orders",
            "INSERT INTO orders (note) VALUES ('x')",
            "PRAGMA user_version = 5",
            "CREATE TABLE x (a)",
        ] {
            assert!(exec.query(sql, 5, &ctx()).await.is_err(), "{sql}");
        }
        let conn = Connection::open(&db.path).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM orders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 0);
    }

    #[tokio::test]
    async fn a_long_query_stops_on_cancel() {
        let (_db, exec) = database();
        let ctx = ctx();
        let cancel = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel.cancel();
        });
        let started = Instant::now();
        let err = exec
            .query(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c \
                 WHERE x < 300000000) SELECT count(*) FROM c",
                1,
                &ctx,
            )
            .await
            .unwrap_err();
        assert_eq!(err, "query stopped");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn wide_rows_and_long_values_are_bounded() {
        let (_db, exec) = database();
        let wide: Vec<String> = (0..60).map(|i| format!("{i} AS c{i}")).collect();
        let rows = exec
            .query(
                &format!(
                    "SELECT {}, printf('%.*c', 100000, 'x') AS big",
                    wide.join(", ")
                ),
                1,
                &ctx(),
            )
            .await
            .unwrap();
        let row = rows.rows[0].as_object().unwrap();
        assert_eq!(row.len(), MAX_COLUMNS);
        let rows = exec
            .query("SELECT printf('%.*c', 100000, 'é') AS big", 1, &ctx())
            .await
            .unwrap();
        assert_eq!(
            rows.rows[0]["big"].as_str().unwrap().chars().count(),
            MAX_CELL_CHARS + 1
        );
    }
}
