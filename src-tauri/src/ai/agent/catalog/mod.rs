//! Metadata tools for the agent (plan ai-agent R3, Phase 2).
//!
//! The model never writes SQL here: every tool runs fixed catalog queries with bound
//! parameters through a per-engine [`CatalogExecutor`], each on its own read-only
//! transaction (or, for SQLite, read-only pragmas) with a timeout and cancellation.

mod mysql;
pub(crate) mod postgres;
mod sqlite;
pub mod tools;

use std::future::Future;
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::run::ToolContext;
use crate::engines::EngineConnection;

pub const MAX_SCHEMAS: usize = 200;
pub const MAX_TABLES: usize = 500;
pub const MAX_COLUMNS: usize = 200;
pub const MAX_FOREIGN_KEYS: usize = 100;
pub const MAX_INDEXES: usize = 100;
/// Free text from the catalog (comments, defaults) is cut to this many chars.
pub const MAX_TEXT_CHARS: usize = 200;
/// Statement timeout for catalog queries.
pub const CATALOG_TIMEOUT: Duration = Duration::from_secs(10);
/// After a stop: time to deliver the interrupt (cancel request, `KILL QUERY`)...
pub const INTERRUPT_GRACE: Duration = Duration::from_millis(1000);
/// ...then for the interrupted query to unwind...
pub const UNWIND_GRACE: Duration = Duration::from_millis(1500);
/// ...then to close the interrupted session.
pub const DISCONNECT_GRACE: Duration = Duration::from_millis(1000);

// A stopped catalog call finishes all its cleanup within the run's cleanup grace, so
// the run's slot is released only after the session is gone.
const _: () = assert!(
    INTERRUPT_GRACE.as_millis() + UNWIND_GRACE.as_millis() + DISCONNECT_GRACE.as_millis()
        < super::run::CLEANUP_GRACE.as_millis()
);

pub const TABLE_NOT_FOUND: &str = "table not found";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableRef {
    pub schema: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    pub primary_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ForeignKey {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references_schema: Option<String>,
    pub references_table: String,
    pub references_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Index {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableDescription {
    pub schema: String,
    pub name: String,
    pub columns: Vec<Column>,
    pub foreign_keys: Vec<ForeignKey>,
    pub indexes: Vec<Index>,
    /// Some list hit its cap.
    pub truncated: bool,
}

/// Catalog access for one runtime connection. Implementations run only fixed,
/// parameterised statements, never text from the model.
#[async_trait]
pub trait CatalogExecutor: Send + Sync {
    /// The dialect name shown to the model ("PostgreSQL", "MySQL", …).
    fn dialect(&self) -> &'static str;
    async fn list_schemas(&self, ctx: &ToolContext) -> Result<Vec<String>, String>;
    async fn list_tables(
        &self,
        schema: Option<&str>,
        name_contains: Option<&str>,
        ctx: &ToolContext,
    ) -> Result<Vec<TableRef>, String>;
    async fn describe_table(
        &self,
        schema: &str,
        table: &str,
        ctx: &ToolContext,
    ) -> Result<TableDescription, String>;
    /// The engine key for [`crate::ai::agent::sql_safety::classify`].
    fn sql_engine(&self) -> &'static str;
    /// Whether a query whose calls are spelled like built-ins can only reach built-in,
    /// side-effect-free code on this connection: no user functions it could resolve
    /// to, and no views (or policies, domain checks) that run anything else. `false`
    /// when unsure. Asked before the assistant offers Run for a suggested query.
    async fn only_builtin_code(&self, ctx: &ToolContext) -> Result<bool, String>;
}

/// Most views checked by [`CatalogExecutor::only_builtin_code`]; more is "unsure".
pub const MAX_CHECKED_VIEWS: usize = 200;

/// Whether every view definition is itself a plain read-only query.
pub(crate) fn views_are_plain(definitions: &[Option<String>], engine: &str) -> bool {
    definitions.len() <= MAX_CHECKED_VIEWS
        && definitions.iter().all(|definition| {
            definition.as_deref().is_some_and(|sql| {
                super::sql_safety::classify(sql, engine) == super::sql_safety::SqlSafety::ReadOnly
            })
        })
}

/// The executor for a runtime connection, or `None` for engines without agent
/// metadata support in v1 (plan R3: Postgres, MySQL, MariaDB, SQLite).
pub fn executor_for(connection: &EngineConnection) -> Option<std::sync::Arc<dyn CatalogExecutor>> {
    match connection {
        EngineConnection::Postgres(pg) => Some(std::sync::Arc::new(postgres::PgCatalog::new(
            pg.pool.clone(),
        ))),
        EngineConnection::MySql(my) => Some(std::sync::Arc::new(mysql::MySqlCatalog::new(
            my.pool.clone(),
            my.engine,
        ))),
        EngineConnection::Sqlite(lite) => Some(std::sync::Arc::new(sqlite::SqliteCatalog::new(
            lite.conn.clone(),
        ))),
        _ => None,
    }
}

/// Runs `op` as a task owned by the run's tracker; the caller only awaits its result.
/// If the run is cancelled and the tool future dropped, the task still finishes its
/// interruption and cleanup before the session is released, and the run waits for it.
pub(crate) async fn owned<T: Send + 'static>(
    ctx: &ToolContext,
    op: impl Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    ctx.tracker.spawn(async move {
        let _ = tx.send(op.await);
    });
    rx.await.unwrap_or_else(|_| Err("canceled".to_string()))
}

/// Checks a session out of a pool, bounded by `timeout` and stopped by cancel.
pub(crate) async fn acquire<C, E>(
    get: impl Future<Output = Result<C, E>>,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<C, String> {
    let checked_out = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("canceled".to_string()),
        result = tokio::time::timeout(timeout, get) => result,
    };
    match checked_out {
        Ok(Ok(session)) if !cancel.is_cancelled() => Ok(session),
        Ok(Ok(_)) => Err("canceled".to_string()),
        _ => Err("could not get a database connection".to_string()),
    }
}

/// Drives `work` (which borrows the caller's session) until it finishes, the run is
/// cancelled or `timeout` passes. On a stop, `interrupt` runs (up to
/// [`INTERRUPT_GRACE`]) while the caller still owns the session, then `work` gets
/// [`UNWIND_GRACE`] to unwind. Returns the outcome
/// and whether the session was interrupted; an interrupted session must be discarded,
/// never returned to its pool.
pub(crate) async fn interruptible<T>(
    work: impl Future<Output = Result<T, String>>,
    cancel: &CancellationToken,
    timeout: Duration,
    interrupt: impl Future<Output = ()>,
) -> (Result<T, String>, bool) {
    tokio::pin!(work);
    tokio::select! {
        biased;
        result = &mut work => return (result, false),
        _ = cancel.cancelled() => {}
        _ = tokio::time::sleep(timeout) => {}
    }
    let _ = tokio::time::timeout(INTERRUPT_GRACE, interrupt).await;
    let _ = tokio::time::timeout(UNWIND_GRACE, &mut work).await;
    let reason = if cancel.is_cancelled() {
        "canceled"
    } else {
        "catalog query timed out"
    };
    (Err(reason.to_string()), true)
}

/// Cuts free text from the catalog to [`MAX_TEXT_CHARS`].
pub fn clip(text: Option<String>) -> Option<String> {
    text.map(|text| {
        if text.chars().count() <= MAX_TEXT_CHARS {
            text
        } else {
            let mut cut: String = text.chars().take(MAX_TEXT_CHARS).collect();
            cut.push('…');
            cut
        }
    })
}

/// Keeps at most `max` items; reports whether anything was dropped.
pub fn cap<T>(mut items: Vec<T>, max: usize) -> (Vec<T>, bool) {
    let truncated = items.len() > max;
    items.truncate(max);
    (items, truncated)
}

/// Groups consecutive rows `(key, rest…)` into one entry per key, keeping order.
pub fn group_by<K: PartialEq + Clone, R, T>(
    rows: Vec<(K, R)>,
    mut start: impl FnMut(&K, &R) -> T,
    mut extend: impl FnMut(&mut T, R),
) -> Vec<T> {
    let mut out: Vec<(K, T)> = Vec::new();
    for (key, rest) in rows {
        match out.last_mut() {
            Some((last, item)) if *last == key => extend(item, rest),
            _ => {
                let mut item = start(&key, &rest);
                extend(&mut item, rest);
                out.push((key, item));
            }
        }
    }
    out.into_iter().map(|(_, item)| item).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio_util::task::TaskTracker;

    fn ctx() -> ToolContext {
        ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        }
    }

    #[tokio::test]
    async fn finished_work_is_never_interrupted() {
        let cancel = CancellationToken::new();
        let interrupts = AtomicUsize::new(0);
        let (outcome, interrupted) = interruptible(
            async { Ok::<_, String>(7) },
            &cancel,
            Duration::from_secs(5),
            async {
                interrupts.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert_eq!(outcome, Ok(7));
        assert!(!interrupted);
        assert_eq!(interrupts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_stop_interrupts_while_the_session_is_still_held() {
        for cancel_first in [true, false] {
            let cancel = CancellationToken::new();
            // Stands in for the checked-out session: cleared when the work unwinds.
            let held = Arc::new(AtomicBool::new(true));
            let seen_held = Arc::new(AtomicBool::new(false));
            let interrupted_flag = Arc::new(tokio::sync::Notify::new());
            let work = {
                let held = held.clone();
                let notify = interrupted_flag.clone();
                async move {
                    notify.notified().await;
                    held.store(false, Ordering::SeqCst);
                    Err::<(), _>("query stopped".to_string())
                }
            };
            let interrupt = {
                let held = held.clone();
                let seen = seen_held.clone();
                let notify = interrupted_flag.clone();
                async move {
                    seen.store(held.load(Ordering::SeqCst), Ordering::SeqCst);
                    notify.notify_one();
                }
            };
            if cancel_first {
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    cancel.cancel();
                });
            }
            let (outcome, interrupted) =
                interruptible(work, &cancel, Duration::from_millis(200), interrupt).await;
            assert!(interrupted);
            assert!(seen_held.load(Ordering::SeqCst), "interrupt after release");
            assert!(!held.load(Ordering::SeqCst), "work did not unwind");
            let expected = if cancel_first {
                "canceled"
            } else {
                "catalog query timed out"
            };
            assert_eq!(outcome.unwrap_err(), expected);
        }
    }

    #[tokio::test]
    async fn owned_work_finishes_cleanup_after_the_caller_is_dropped() {
        let ctx = ctx();
        let cleaned = Arc::new(AtomicBool::new(false));
        let op = {
            let cancel = ctx.cancel.clone();
            let cleaned = cleaned.clone();
            async move {
                cancel.cancelled().await;
                tokio::time::sleep(Duration::from_millis(200)).await;
                cleaned.store(true, Ordering::SeqCst);
                Err::<(), _>("canceled".to_string())
            }
        };
        let caller = owned(&ctx, op);
        // The coordinator drops the tool future on run cancel.
        let _ = tokio::time::timeout(Duration::from_millis(10), caller).await;
        ctx.cancel.cancel();
        assert!(!cleaned.load(Ordering::SeqCst));
        ctx.tracker.close();
        ctx.tracker.wait().await;
        assert!(cleaned.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn acquiring_from_an_exhausted_pool_is_bounded() {
        let cancel = CancellationToken::new();
        let never = std::future::pending::<Result<(), ()>>();
        let err = acquire(never, &cancel, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(err, "could not get a database connection");

        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            stopper.cancel();
        });
        let never = std::future::pending::<Result<(), ()>>();
        let err = acquire(never, &cancel, Duration::from_secs(60))
            .await
            .unwrap_err();
        assert_eq!(err, "canceled");
        // A session that arrives after cancel is not used.
        let err = acquire(async { Ok::<_, ()>(()) }, &cancel, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(err, "canceled");
    }

    #[test]
    fn clip_and_cap() {
        assert_eq!(clip(Some("ab".into())), Some("ab".into()));
        let long = "é".repeat(MAX_TEXT_CHARS + 5);
        let clipped = clip(Some(long)).unwrap();
        assert_eq!(clipped.chars().count(), MAX_TEXT_CHARS + 1);
        assert_eq!(cap(vec![1, 2, 3], 2), (vec![1, 2], true));
        assert_eq!(cap(vec![1], 2), (vec![1], false));
    }

    #[test]
    fn group_by_keeps_order() {
        let rows = vec![("a", 1), ("a", 2), ("b", 3)];
        let grouped = group_by(
            rows,
            |k, _| (k.to_string(), Vec::new()),
            |item, v| item.1.push(v),
        );
        assert_eq!(
            grouped,
            vec![("a".into(), vec![1, 2]), ("b".into(), vec![3])]
        );
    }
}
