//! SQLite catalog: `sqlite_master` and read-only `pragma_*` table functions with bound
//! parameters, on the connection's shared handle (also the only way to see a
//! `:memory:` database). These statements cannot write; a watcher interrupts them on
//! cancel or after [`CATALOG_TIMEOUT`].

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rusqlite::{params, Connection, InterruptHandle};

use super::{
    cap, clip, group_by, CatalogExecutor, Column, ForeignKey, Index, TableDescription, TableRef,
    CATALOG_TIMEOUT, INTERRUPT_GRACE, MAX_COLUMNS, MAX_FOREIGN_KEYS, MAX_INDEXES, MAX_SCHEMAS,
    MAX_TABLES, TABLE_NOT_FOUND, UNWIND_GRACE,
};
use crate::ai::agent::run::ToolContext;

/// Only the main database is exposed.
const MAIN: &str = "main";

pub struct SqliteCatalog {
    conn: Arc<Mutex<Connection>>,
    timeout: Duration,
}

impl SqliteCatalog {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self {
            conn,
            timeout: CATALOG_TIMEOUT,
        }
    }

    /// Runs `work` on a blocking thread holding the connection. Waiting for the lock
    /// (the editor may be running a query) and the work itself are bounded by the
    /// catalog timeout and stop on cancel.
    async fn with_conn<T: Send + 'static>(
        &self,
        ctx: &ToolContext,
        work: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let conn = self.conn.clone();
        let cancel = ctx.cancel.clone();
        let done = ctx.cancel.child_token();
        let arm = Arc::new(Mutex::new(Arm::default()));
        let timeout = self.timeout;

        // On cancel or timeout: mark the call stopped, then keep interrupting while
        // the worker holds the connection. A single interrupt can land between two
        // statements, where SQLite ignores it.
        let watcher_arm = arm.clone();
        let watcher_done = done.clone();
        ctx.tracker.spawn(async move {
            tokio::select! {
                _ = watcher_done.cancelled() => {}
                _ = tokio::time::sleep(timeout) => {}
            }
            let until = Instant::now() + INTERRUPT_GRACE + UNWIND_GRACE;
            watcher_arm
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .stopped = true;
            loop {
                {
                    let arm = watcher_arm.lock().unwrap_or_else(|e| e.into_inner());
                    if arm.finished {
                        break;
                    }
                    if let Some(handle) = &arm.handle {
                        handle.interrupt();
                    }
                }
                if Instant::now() >= until {
                    break;
                }
                tokio::time::sleep(INTERRUPT_EVERY).await;
            }
        });

        let deadline = Instant::now() + timeout;
        let result = ctx
            .tracker
            .spawn_blocking(move || {
                let _finish = Finish(arm.clone());
                let stop_reason = |cancel: &tokio_util::sync::CancellationToken| {
                    if cancel.is_cancelled() {
                        "canceled".to_string()
                    } else {
                        "the database is busy".to_string()
                    }
                };
                let stopped =
                    |arm: &Mutex<Arm>| arm.lock().unwrap_or_else(|e| e.into_inner()).stopped;
                let guard = loop {
                    if cancel.is_cancelled() || stopped(&arm) || Instant::now() >= deadline {
                        return Err(stop_reason(&cancel));
                    }
                    match conn.try_lock() {
                        Ok(guard) => break guard,
                        Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
                        Err(std::sync::TryLockError::WouldBlock) => {
                            std::thread::sleep(INTERRUPT_EVERY);
                        }
                    }
                };
                {
                    // Arm under the same lock the watcher stops under: either the
                    // watcher sees the handle, or this check sees the stop.
                    let mut state = arm.lock().unwrap_or_else(|e| e.into_inner());
                    if state.stopped || cancel.is_cancelled() || Instant::now() >= deadline {
                        return Err(stop_reason(&cancel));
                    }
                    state.handle = Some(guard.get_interrupt_handle());
                }
                // From here on the handle is cleared before the connection is
                // released, on every exit including a panic.
                let held = Held::new(guard, arm.clone());
                work(held.connection()).map_err(|e| match e.sqlite_error_code() {
                    Some(rusqlite::ErrorCode::OperationInterrupted) => {
                        "catalog query stopped".to_string()
                    }
                    _ => "catalog query failed".to_string(),
                })
            })
            .await
            .map_err(|_| "catalog query failed".to_string())?;
        done.cancel();
        result
    }
}

const INTERRUPT_EVERY: Duration = Duration::from_millis(20);

/// Interrupt state shared by the worker and its watcher.
#[derive(Default)]
struct Arm {
    /// The call was cancelled or timed out; no catalog work may start.
    stopped: bool,
    /// The worker released the connection.
    finished: bool,
    handle: Option<InterruptHandle>,
}

fn disarm(arm: &Mutex<Arm>) {
    let mut arm = arm.lock().unwrap_or_else(|e| e.into_inner());
    arm.handle = None;
    arm.finished = true;
}

/// Marks the worker finished on exits before it holds the connection.
struct Finish(Arc<Mutex<Arm>>);

impl Drop for Finish {
    fn drop(&mut self) {
        disarm(&self.0);
    }
}

/// The shared connection while armed. Dropping it disarms first and only then unlocks
/// the connection, so the watcher can never interrupt whoever takes it next (the
/// editor).
struct Held<'a> {
    guard: Option<MutexGuard<'a, Connection>>,
    arm: Arc<Mutex<Arm>>,
}

impl<'a> Held<'a> {
    fn new(guard: MutexGuard<'a, Connection>, arm: Arc<Mutex<Arm>>) -> Self {
        Self {
            guard: Some(guard),
            arm,
        }
    }

    fn connection(&self) -> &Connection {
        self.guard.as_ref().expect("held until drop")
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        disarm(&self.arm);
        drop(self.guard.take());
    }
}

fn ensure_main(schema: &str) -> Result<(), String> {
    if schema.eq_ignore_ascii_case(MAIN) {
        Ok(())
    } else {
        Err("SQLite exposes only the 'main' schema".into())
    }
}

#[async_trait]
impl CatalogExecutor for SqliteCatalog {
    fn dialect(&self) -> &'static str {
        "SQLite"
    }

    fn sql_engine(&self) -> &'static str {
        "sqlite"
    }

    /// The app registers no SQL functions and extension loading stays off, so SQLite
    /// built-ins (and views over them) are all a query can reach.
    async fn only_builtin_code(&self, _ctx: &ToolContext) -> Result<bool, String> {
        Ok(true)
    }

    async fn list_schemas(&self, ctx: &ToolContext) -> Result<Vec<String>, String> {
        self.with_conn(ctx, |conn| {
            // Attached databases are not exposed in v1.
            let mut stmt =
                conn.prepare("SELECT name FROM pragma_database_list WHERE name = 'main'")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut names = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            names.truncate(MAX_SCHEMAS + 1);
            Ok(names)
        })
        .await
    }

    async fn list_tables(
        &self,
        schema: Option<&str>,
        name_contains: Option<&str>,
        ctx: &ToolContext,
    ) -> Result<Vec<TableRef>, String> {
        if let Some(schema) = schema {
            ensure_main(schema)?;
        }
        let needle = name_contains.map(str::to_string);
        self.with_conn(ctx, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT name, type FROM main.sqlite_master \
                 WHERE type IN ('table', 'view') \
                   AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                   AND (?1 IS NULL OR instr(lower(name), lower(?1)) > 0) \
                 ORDER BY name LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![needle, (MAX_TABLES + 1) as i64], |row| {
                Ok(TableRef {
                    schema: MAIN.into(),
                    name: row.get(0)?,
                    kind: row.get(1)?,
                })
            })?;
            rows.collect()
        })
        .await
    }

    async fn describe_table(
        &self,
        schema: &str,
        table: &str,
        ctx: &ToolContext,
    ) -> Result<TableDescription, String> {
        ensure_main(schema)?;
        let table = table.to_string();
        let described = self
            .with_conn(ctx, move |conn| {
                let exists: Option<String> = conn
                    .query_row(
                        "SELECT name FROM main.sqlite_master WHERE type IN ('table', 'view') AND name = ?1",
                        params![table],
                        |row| row.get(0),
                    )
                    .ok();
                let Some(table) = exists else {
                    return Ok(None);
                };

                let mut stmt = conn.prepare(
                    "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1, 'main') LIMIT ?2",
                )?;
                let columns = stmt
                    .query_map(params![table, (MAX_COLUMNS + 1) as i64], |row| {
                        Ok(Column {
                            name: row.get(0)?,
                            data_type: row.get(1)?,
                            nullable: row.get::<_, i64>(2)? == 0,
                            default: clip(row.get(3)?),
                            primary_key: row.get::<_, i64>(4)? > 0,
                            comment: None,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;

                let mut stmt = conn.prepare(
                    "SELECT id, \"from\", \"table\", \"to\" FROM pragma_foreign_key_list(?1, 'main') ORDER BY id, seq",
                )?;
                let fk_rows = stmt
                    .query_map(params![table], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            (row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?),
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let foreign_keys = group_by(
                    fk_rows,
                    |_, (_, target, _)| ForeignKey {
                        name: None,
                        columns: Vec::new(),
                        references_schema: None,
                        references_table: target.clone(),
                        references_columns: Vec::new(),
                    },
                    |fk, (from, _, to)| {
                        fk.columns.push(from);
                        // `to` is NULL when the reference is the target's primary key.
                        fk.references_columns.push(to.unwrap_or_default());
                    },
                );

                let mut stmt = conn.prepare(
                    "SELECT il.name, il.\"unique\", ii.name \
                     FROM pragma_index_list(?1, 'main') AS il, pragma_index_info(il.name, 'main') AS ii \
                     ORDER BY il.name, ii.seqno",
                )?;
                let index_rows = stmt
                    .query_map(params![table], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            (row.get::<_, i64>(1)? != 0, row.get::<_, Option<String>>(2)?),
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let indexes = group_by(
                    index_rows,
                    |name, (unique, _)| Index {
                        name: name.clone(),
                        unique: *unique,
                        columns: Vec::new(),
                    },
                    |index, (_, column)| index.columns.push(column.unwrap_or_else(|| "<expression>".into())),
                );
                Ok(Some((table, columns, foreign_keys, indexes)))
            })
            .await?;

        let Some((table, columns, foreign_keys, indexes)) = described else {
            return Err(TABLE_NOT_FOUND.into());
        };
        let (columns, c) = cap(columns, MAX_COLUMNS);
        let (foreign_keys, f) = cap(foreign_keys, MAX_FOREIGN_KEYS);
        let (indexes, i) = cap(indexes, MAX_INDEXES);
        Ok(TableDescription {
            schema: MAIN.into(),
            name: table,
            columns,
            foreign_keys,
            indexes,
            truncated: c || f || i,
        })
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

    fn catalog() -> SqliteCatalog {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
             CREATE TABLE orders (
               id INTEGER PRIMARY KEY,
               customer_id INTEGER NOT NULL REFERENCES customers(id),
               total REAL DEFAULT 0,
               note TEXT
             );
             CREATE INDEX orders_customer ON orders(customer_id, total);
             CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;",
        )
        .unwrap();
        SqliteCatalog::new(Arc::new(Mutex::new(conn)))
    }

    #[tokio::test]
    async fn lists_and_describes() {
        let catalog = catalog();
        let ctx = ctx();
        assert_eq!(catalog.list_schemas(&ctx).await.unwrap(), vec!["main"]);
        let tables = catalog.list_tables(None, None, &ctx).await.unwrap();
        let names: Vec<_> = tables
            .iter()
            .map(|t| (t.name.as_str(), t.kind.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("big_orders", "view"),
                ("customers", "table"),
                ("orders", "table")
            ]
        );
        let filtered = catalog
            .list_tables(Some("main"), Some("ORD"), &ctx)
            .await
            .unwrap();
        assert_eq!(filtered.len(), 2);

        let orders = catalog
            .describe_table("main", "orders", &ctx)
            .await
            .unwrap();
        assert_eq!(orders.columns.len(), 4);
        assert!(orders.columns[0].primary_key);
        assert!(!orders.columns[1].nullable);
        assert_eq!(orders.columns[2].default.as_deref(), Some("0"));
        assert_eq!(orders.foreign_keys.len(), 1);
        assert_eq!(orders.foreign_keys[0].references_table, "customers");
        assert_eq!(orders.foreign_keys[0].columns, vec!["customer_id"]);
        let index = orders
            .indexes
            .iter()
            .find(|i| i.name == "orders_customer")
            .unwrap();
        assert_eq!(index.columns, vec!["customer_id", "total"]);
        assert!(!index.unique);
    }

    #[tokio::test]
    async fn search_text_is_not_a_pattern_and_names_are_bound() {
        let catalog = catalog();
        let ctx = ctx();
        // `%` and `_` are plain characters here, not wildcards.
        assert!(catalog
            .list_tables(None, Some("%"), &ctx)
            .await
            .unwrap()
            .is_empty());
        // As a pattern `_` would match every name; literally only one has it.
        let underscore = catalog.list_tables(None, Some("_"), &ctx).await.unwrap();
        let names: Vec<_> = underscore.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["big_orders"]);
        let injected = "orders'); DROP TABLE orders; --";
        assert_eq!(
            catalog
                .describe_table("main", injected, &ctx)
                .await
                .unwrap_err(),
            TABLE_NOT_FOUND
        );
        // Still there.
        assert!(catalog.describe_table("main", "orders", &ctx).await.is_ok());
    }

    #[tokio::test]
    async fn only_main_is_exposed() {
        let catalog = catalog();
        let ctx = ctx();
        assert!(catalog.list_tables(Some("temp"), None, &ctx).await.is_err());
        assert!(catalog
            .describe_table("other", "orders", &ctx)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_cancelled_call_does_not_run() {
        let catalog = catalog();
        let ctx = ctx();
        ctx.cancel.cancel();
        assert!(catalog.list_tables(None, None, &ctx).await.is_err());
    }

    #[tokio::test]
    async fn waits_for_a_busy_connection_then_gives_up_on_cancel() {
        let catalog = catalog();
        let ctx = ctx();
        // Another thread (the editor) holds the connection for a while.
        let held = catalog.conn.clone();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let editor = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            locked_tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(500));
        });
        locked_rx.recv().unwrap();
        let cancel = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let started = Instant::now();
        assert!(catalog.list_tables(None, None, &ctx).await.is_err());
        assert!(started.elapsed() < std::time::Duration::from_millis(400));
        editor.join().unwrap();
    }

    #[tokio::test]
    async fn temp_and_attached_tables_never_shadow_main() {
        let catalog = catalog();
        catalog
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TEMP TABLE orders (temp_secret TEXT REFERENCES customers(id));
                 CREATE INDEX temp.orders_customer ON orders (temp_secret);
                 CREATE TEMP TABLE temp_only (x);
                 ATTACH ':memory:' AS aux;
                 CREATE TABLE aux.orders (aux_secret TEXT);
                 CREATE TABLE aux.aux_only (y);",
            )
            .unwrap();
        let ctx = ctx();
        let orders = catalog
            .describe_table("main", "orders", &ctx)
            .await
            .unwrap();
        let text = serde_json::to_string(&orders).unwrap();
        assert!(!text.contains("temp_secret") && !text.contains("aux_secret"));
        assert_eq!(orders.columns[0].name, "id");
        let index = orders
            .indexes
            .iter()
            .find(|i| i.name == "orders_customer")
            .unwrap();
        assert_eq!(index.columns, vec!["customer_id", "total"]);
        let names: Vec<_> = catalog
            .list_tables(None, None, &ctx)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(!names.iter().any(|n| n == "temp_only" || n == "aux_only"));
        assert_eq!(
            catalog
                .describe_table("main", "temp_only", &ctx)
                .await
                .unwrap_err(),
            TABLE_NOT_FOUND
        );
    }

    #[tokio::test]
    async fn a_stop_before_the_first_statement_still_interrupts_it() {
        let catalog = catalog();
        let ctx = ctx();
        let cancel = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            cancel.cancel();
        });
        let run = catalog.with_conn(&ctx, |conn| {
            // The stop lands here, after arming but before any statement runs; a
            // single interrupt would be ignored by SQLite.
            std::thread::sleep(Duration::from_millis(150));
            // Long but finite, so a regression fails instead of hanging the suite.
            conn.query_row(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c \
                 WHERE x < 300000000) SELECT count(*) FROM c",
                [],
                |row| row.get::<_, i64>(0),
            )
        });
        let started = Instant::now();
        assert_eq!(run.await.unwrap_err(), "catalog query stopped");
        assert!(started.elapsed() < Duration::from_secs(3));
        ctx.tracker.close();
        ctx.tracker.wait().await;
        // The editor's connection is still usable.
        assert!(catalog.list_tables(None, None, &self::ctx()).await.is_ok());
    }

    #[tokio::test]
    async fn no_work_starts_when_the_lock_frees_after_the_deadline() {
        let mut catalog = catalog();
        catalog.timeout = Duration::from_millis(100);
        let held = catalog.conn.clone();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let editor = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            locked_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        locked_rx.recv().unwrap();
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran.clone();
        let ctx = ctx();
        let err = catalog
            .with_conn(&ctx, move |_| {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap_err();
        assert_eq!(err, "the database is busy");
        editor.join().unwrap();
        ctx.tracker.close();
        ctx.tracker.wait().await;
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// Whoever locks the connection after a catalog call never finds an armed handle,
    /// on normal return and on panic.
    #[test]
    fn the_handle_is_disarmed_before_the_connection_is_released() {
        for panic in [false, true] {
            let conn = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
            let arm = Arc::new(Mutex::new(Arm::default()));
            let guard = conn.lock().unwrap();
            arm.lock().unwrap().handle = Some(guard.get_interrupt_handle());
            let (next, observer_arm) = (conn.clone(), arm.clone());
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            // The editor, waiting for the connection.
            let editor = std::thread::spawn(move || {
                ready_tx.send(()).unwrap();
                let _taken = next.lock().unwrap_or_else(|e| e.into_inner());
                let state = observer_arm.lock().unwrap_or_else(|e| e.into_inner());
                (state.handle.is_none(), state.finished)
            });
            ready_rx.recv().unwrap();
            std::thread::sleep(Duration::from_millis(20));
            let held = Held::new(guard, arm.clone());
            if panic {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    let _held = held;
                    panic!("work failed");
                }));
                assert!(outcome.is_err());
            } else {
                drop(held);
            }
            assert_eq!(editor.join().unwrap(), (true, true), "panic: {panic}");
        }
    }
}
