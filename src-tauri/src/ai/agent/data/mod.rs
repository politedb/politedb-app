//! Data tools for the agent (plan ai-agent R4/R5, Phase 3): PostgreSQL and SQLite only.
//!
//! Every query is validated by [`super::query_guard`], runs read-only on a session
//! nobody else uses (discarded afterwards), with a timeout, a row cap and cancellation,
//! and only after the user's data-access consent (and, in safe/production mode, a
//! native approval) for that exact SQL.

mod postgres;
mod sqlite;
pub mod tools;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::query_guard::GuardDialect;
use super::run::ToolContext;
use crate::engines::EngineConnection;

/// Statement timeout for agent data queries.
pub const DATA_TIMEOUT: Duration = Duration::from_secs(15);
/// Rows `sample_rows` may return.
pub const MAX_SAMPLE_ROWS: usize = 20;
/// Rows `run_readonly_query` may return.
pub const MAX_QUERY_ROWS: usize = 200;
/// Longest text kept per cell.
pub const MAX_CELL_CHARS: usize = 500;
/// Columns kept per row.
pub const MAX_COLUMNS: usize = 50;
/// Longest query plan kept.
pub const MAX_PLAN_CHARS: usize = 16 * 1024;

/// Rows as JSON objects (column → value), in result order.
#[derive(Debug, Clone, PartialEq)]
pub struct Rows {
    pub rows: Vec<Value>,
    /// More rows existed than were kept.
    pub truncated: bool,
}

/// Runs validated, read-only SQL for one runtime connection.
#[async_trait]
pub trait DataExecutor: Send + Sync {
    fn dialect(&self) -> GuardDialect;
    /// `sql` must come from [`super::query_guard::validate`]. Errors are short and safe
    /// to show the model (the connection has data consent).
    async fn query(&self, sql: &str, limit: usize, ctx: &ToolContext) -> Result<Rows, String>;
    async fn explain(&self, sql: &str, ctx: &ToolContext) -> Result<String, String>;
}

/// The data executor for a runtime connection, or `None` when data tools are not
/// available there (other engines; SQLite in memory or opened by URI).
pub fn executor_for(connection: &EngineConnection) -> Option<Arc<dyn DataExecutor>> {
    match connection {
        EngineConnection::Postgres(pg) => Some(Arc::new(postgres::PgData::new(pg.pool.clone()))),
        EngineConnection::Sqlite(lite) => sqlite::SqliteData::for_path(&lite.db_path)
            .map(|e| Arc::new(e) as Arc<dyn DataExecutor>),
        _ => None,
    }
}

/// Cuts long strings inside a JSON value to [`MAX_CELL_CHARS`].
pub fn clip_value(value: Value) -> Value {
    match value {
        Value::String(text) if text.chars().count() > MAX_CELL_CHARS => {
            let mut cut: String = text.chars().take(MAX_CELL_CHARS).collect();
            cut.push('…');
            Value::String(cut)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(clip_value).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, clip_value(v))).collect())
        }
        other => other,
    }
}

/// A database error cut to one short line for the model.
pub fn short_error(message: &str) -> String {
    let line = message.lines().next().unwrap_or("").trim();
    let cut: String = line.chars().take(300).collect();
    if cut.is_empty() {
        "query failed".to_string()
    } else {
        format!("query failed: {cut}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_and_errors_are_bounded() {
        let long = "x".repeat(MAX_CELL_CHARS + 10);
        let clipped = clip_value(serde_json::json!({ "a": long, "b": [long], "c": 1 }));
        assert_eq!(
            clipped["a"].as_str().unwrap().chars().count(),
            MAX_CELL_CHARS + 1
        );
        assert_eq!(clipped["c"], 1);
        assert_eq!(short_error(""), "query failed");
        assert_eq!(short_error("boom\ndetail"), "query failed: boom");
    }
}
