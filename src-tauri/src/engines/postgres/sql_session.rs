//! A PostgreSQL session held across calls, for work that must see or
//! change the database as a whole: a restore that runs in one transaction
//! (all or nothing), and a backup whose queries all read one exported
//! snapshot.
//!
//! Each session has its own connection, opened from the runtime's settings
//! and closed when the session ends: never a pooled one. A pool of one
//! would otherwise deadlock (the session holding its only slot while the
//! backup's queries wait for it), and a connection that ran arbitrary
//! imported SQL (session settings, advisory locks) is never handed to
//! another caller.

use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use tokio::sync::Mutex;
use tokio::time::Instant;
use tokio_postgres::{CancelToken, Client, Config, NoTls};
use uuid::Uuid;

use super::explain_analyze::{connect_quiet, SessionTask};
use super::operation::format_pg_error;

/// What a session is opened for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SqlSessionMode {
    /// A read-write transaction, committed or rolled back at the end.
    Transaction,
    /// A read-only REPEATABLE READ transaction whose snapshot is exported,
    /// so other connections can read the same database state.
    Snapshot,
}

impl SqlSessionMode {
    /// How long the session may sit unused before it is reclaimed (by the
    /// server, and here). A snapshot session idles while the backup's
    /// streams read through other connections.
    fn idle_limit(self) -> Duration {
        match self {
            SqlSessionMode::Transaction => Duration::from_secs(15 * 60),
            SqlSessionMode::Snapshot => Duration::from_secs(6 * 60 * 60),
        }
    }
}

use std::sync::atomic::Ordering::SeqCst;

const OPEN: u8 = 0;
const ENDING: u8 = 1;
const CLOSED: u8 = 2;

/// One statement's limit, as the per-statement runs had.
const STATEMENT_LIMIT: Duration = Duration::from_secs(120);
const CONNECT_LIMIT: Duration = Duration::from_secs(30);
const END_LIMIT: Duration = Duration::from_secs(30);
/// Setting a session up (its settings, BEGIN, the snapshot export).
const SETUP_LIMIT: Duration = Duration::from_secs(30);
/// Asking the server to cancel a statement (it opens its own connection).
const CANCEL_LIMIT: Duration = Duration::from_secs(10);
/// How often a session's idle time is checked.
const WATCH_INTERVAL: Duration = Duration::from_secs(60);

struct PgSqlSession {
    connection_id: Uuid,
    mode: SqlSessionMode,
    cancel: CancelToken,
    /// Stops the connection's driver task, reachable without the client
    /// lock (a statement may hold it): the socket closes, the statement
    /// fails, and the server rolls back.
    abort: tokio::task::AbortHandle,
    /// OPEN, ENDING (commit or rollback asked) or CLOSED (forced). Past
    /// OPEN no statement starts; a forced close wins over an ending, which
    /// then sends no COMMIT.
    state: std::sync::atomic::AtomicU8,
    /// None once ended. Dropping it closes the connection; the server then
    /// rolls back anything still open.
    client: Mutex<Option<(Client, SessionTask)>>,
    last_used: std::sync::Mutex<Instant>,
}

impl PgSqlSession {
    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .map(|t| t.elapsed())
            .unwrap_or_default()
    }
}

pub struct SqlSessionRegistry {
    sessions: DashMap<Uuid, Arc<PgSqlSession>>,
    /// Scales the idle limits and the watch interval (tests shorten them).
    timing: Timing,
}

#[derive(Clone, Copy)]
struct Timing {
    watch_interval: Duration,
    idle_scale: f64,
}

impl Default for SqlSessionRegistry {
    fn default() -> Self {
        Self {
            sessions: DashMap::new(),
            timing: Timing {
                watch_interval: WATCH_INTERVAL,
                idle_scale: 1.0,
            },
        }
    }
}

impl SqlSessionRegistry {
    /// Opens a session on its own connection: its transaction, and for a
    /// snapshot session the exported snapshot id.
    pub async fn begin(
        self: &Arc<Self>,
        connection_id: Uuid,
        config: &Config,
        mode: SqlSessionMode,
    ) -> Result<(Uuid, Option<String>), String> {
        self.reclaim_idle().await;

        let (client, task) = tokio::time::timeout(CONNECT_LIMIT, connect_quiet(config))
            .await
            .map_err(|_| "SQL_SESSION_CONNECT_TIMEOUT".to_string())?
            .map_err(|e| format!("SQL_SESSION_CONNECT_FAILED: {e}"))?;
        let idle_ms = self.idle_limit(mode).as_millis();
        let setup = match mode {
            SqlSessionMode::Transaction => format!(
                "SET statement_timeout = {}; \
                 SET idle_in_transaction_session_timeout = {idle_ms}; BEGIN",
                STATEMENT_LIMIT.as_millis()
            ),
            SqlSessionMode::Snapshot => format!(
                "SET idle_in_transaction_session_timeout = {idle_ms}; \
                 BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            ),
        };
        match tokio::time::timeout(SETUP_LIMIT, client.batch_execute(&setup)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(format_pg_error(&e, &setup)),
            Err(_) => return Err("SQL_SESSION_SETUP_TIMEOUT".into()),
        }
        let snapshot = match mode {
            SqlSessionMode::Transaction => None,
            SqlSessionMode::Snapshot => {
                let export = "SELECT pg_export_snapshot()";
                match tokio::time::timeout(SETUP_LIMIT, client.query_one(export, &[])).await {
                    Ok(Ok(row)) => Some(row.get::<usize, String>(0)),
                    Ok(Err(e)) => return Err(format_pg_error(&e, export)),
                    Err(_) => return Err("SQL_SESSION_SETUP_TIMEOUT".into()),
                }
            }
        };
        let id = Uuid::new_v4();
        self.sessions.insert(
            id,
            Arc::new(PgSqlSession {
                connection_id,
                mode,
                cancel: client.cancel_token(),
                abort: task.abort_handle(),
                state: std::sync::atomic::AtomicU8::new(OPEN),
                client: Mutex::new(Some((client, task))),
                last_used: std::sync::Mutex::new(Instant::now()),
            }),
        );
        self.watch(id, mode);
        Ok((id, snapshot))
    }

    /// Runs one SQL statement in the session's transaction (the extended
    /// protocol: a text holding several statements is refused). A statement
    /// past its limit is cancelled and the session ends, rolled back.
    pub async fn execute(&self, session_id: Uuid, sql: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(&session_id)
            .map(|s| Arc::clone(&s))
            .ok_or("SQL_SESSION_NOT_FOUND")?;
        session.touch();
        let result = {
            let guard = session.client.lock().await;
            // Closed while this call waited for the lock.
            if session.state.load(SeqCst) != OPEN {
                return Err("SQL_SESSION_ENDED".into());
            }
            let (client, _) = guard.as_ref().ok_or("SQL_SESSION_ENDED")?;
            tokio::time::timeout(
                STATEMENT_LIMIT + Duration::from_secs(5),
                client.execute(sql, &[]),
            )
            .await
        };
        session.touch();
        match result {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format_pg_error(&e, sql)),
            Err(_) => {
                self.close(session_id).await;
                Err("SQL_SESSION_TIMEOUT".into())
            }
        }
    }

    /// Ends a session: commits or rolls back, then closes its connection.
    /// The session stays listed until then, so a forced close (the
    /// connection going away, a timeout) can still find and stop it; if
    /// one does, nothing is committed.
    pub async fn end(&self, session_id: Uuid, commit: bool) -> Result<(), String> {
        let session = self
            .sessions
            .get(&session_id)
            .map(|s| Arc::clone(&s))
            .ok_or("SQL_SESSION_NOT_FOUND")?;
        // From here no statement starts, queued ones included.
        if session
            .state
            .compare_exchange(OPEN, ENDING, SeqCst, SeqCst)
            .is_err()
        {
            return Err("SQL_SESSION_ENDED".into());
        }
        let result = match tokio::time::timeout(END_LIMIT, session.client.lock()).await {
            // A statement still running past the limit: close instead.
            Err(_) => Err("SQL_SESSION_END_TIMEOUT".to_string()),
            Ok(mut guard) => {
                // A forced close may have won meanwhile: commit nothing.
                if session.state.load(SeqCst) != ENDING {
                    Err("SQL_SESSION_ENDED".to_string())
                } else if let Some((client, _task)) = guard.take() {
                    let end = if commit { "COMMIT" } else { "ROLLBACK" };
                    match tokio::time::timeout(END_LIMIT, client.batch_execute(end)).await {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(e)) => Err(format_pg_error(&e, end)),
                        // Closing the connection (on drop) rolls it back.
                        Err(_) => Err(if commit {
                            "SQL_SESSION_COMMIT_TIMEOUT".into()
                        } else {
                            "SQL_SESSION_ROLLBACK_TIMEOUT".into()
                        }),
                    }
                } else {
                    Ok(())
                }
            }
        };
        if result.is_err() {
            self.close(session_id).await;
        } else {
            self.sessions.remove(&session_id);
        }
        result
    }

    /// Ends a session without waiting on a statement still running: it is
    /// cancelled, the connection closes (rolling back), and an ending in
    /// progress commits nothing.
    async fn close(&self, session_id: Uuid) {
        let Some(session) = self.sessions.get(&session_id).map(|s| Arc::clone(&s)) else {
            return;
        };
        session.state.store(CLOSED, SeqCst);
        // Best effort, bounded: the connection closes below either way.
        let _ = tokio::time::timeout(CANCEL_LIMIT, session.cancel.cancel_query(NoTls)).await;
        // Close the connection now, without waiting for the lock a running
        // statement or an ending may hold: that work then fails.
        session.abort.abort();
        self.sessions.remove(&session_id);
        let taken = match tokio::time::timeout(END_LIMIT, session.client.lock()).await {
            Ok(mut guard) => guard.take(),
            Err(_) => None,
        };
        drop(taken);
    }

    /// Rolls back every session of a connection that is going away.
    pub async fn end_for_connection(&self, connection_id: Uuid) {
        let ids: Vec<Uuid> = self
            .sessions
            .iter()
            .filter(|s| s.value().connection_id == connection_id)
            .map(|s| *s.key())
            .collect();
        for id in ids {
            self.close(id).await;
        }
    }

    fn idle_limit(&self, mode: SqlSessionMode) -> Duration {
        mode.idle_limit().mul_f64(self.timing.idle_scale)
    }

    /// Watches a session's idle time and closes it once past its limit,
    /// whatever the session's own settings (imported SQL may change or
    /// reset idle_in_transaction_session_timeout).
    fn watch(self: &Arc<Self>, session_id: Uuid, mode: SqlSessionMode) {
        let registry = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let interval = match registry.upgrade() {
                    Some(r) => r.timing.watch_interval,
                    None => return,
                };
                tokio::time::sleep(interval).await;
                let Some(registry) = registry.upgrade() else {
                    return;
                };
                let Some(idle) = registry
                    .sessions
                    .get(&session_id)
                    .map(|s| s.value().idle_for())
                else {
                    return;
                };
                if idle > registry.idle_limit(mode) {
                    registry.close(session_id).await;
                    return;
                }
            }
        });
    }

    /// Closes sessions left unused past their limit (a frontend that never
    /// ended them: a reload, a lost reply).
    async fn reclaim_idle(&self) {
        let stale: Vec<Uuid> = self
            .sessions
            .iter()
            .filter(|s| s.value().idle_for() > self.idle_limit(s.value().mode))
            .map(|s| *s.key())
            .collect();
        for id in stale {
            self.close(id).await;
        }
    }
}

/// A snapshot id as pg_export_snapshot writes it (hex digits and dashes),
/// safe to put in SET TRANSACTION SNAPSHOT '…'.
pub fn is_snapshot_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_ids_are_hex_and_dashes_only() {
        assert!(is_snapshot_id("00000003-0000001B-1"));
        assert!(!is_snapshot_id(""));
        assert!(!is_snapshot_id("1'; DROP TABLE t; --"));
        assert!(!is_snapshot_id(&"a".repeat(65)));
    }

    async fn count_rows(c: &deadpool_postgres::Object) -> i64 {
        c.query_one("SELECT count(*) FROM zz_session_t", &[])
            .await
            .unwrap()
            .get(0)
    }

    /// Live checks against a disposable PostgreSQL (never a customer database):
    /// `HEALTH_PG_URL=postgres://user:pass@127.0.0.1:55432/postgres \
    ///  cargo test sql_session_live -- --ignored`
    /// Creates and drops the table `zz_session_t`.
    #[tokio::test]
    #[ignore]
    async fn sql_session_live() {
        use deadpool_postgres::{Manager, ManagerConfig};
        use tokio_postgres::NoTls;

        let cfg: tokio_postgres::Config = std::env::var("HEALTH_PG_URL")
            .expect("set HEALTH_PG_URL")
            .parse()
            .expect("valid HEALTH_PG_URL");
        let pool = deadpool_postgres::Pool::builder(Manager::from_config(
            cfg.clone(),
            NoTls,
            ManagerConfig::default(),
        ))
        .max_size(4)
        .build()
        .unwrap();
        let other = pool.get().await.unwrap();
        other
            .batch_execute("DROP TABLE IF EXISTS zz_session_t; CREATE TABLE zz_session_t (v int)")
            .await
            .unwrap();
        let conn = Uuid::new_v4();
        let reg = Arc::new(SqlSessionRegistry::default());

        // A transaction rolled back leaves nothing; savepoints undo alone.
        let (id, snap) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        assert!(snap.is_none());
        reg.execute(id, "INSERT INTO zz_session_t VALUES (1)")
            .await
            .unwrap();
        reg.execute(id, "SAVEPOINT s").await.unwrap();
        assert!(reg
            .execute(id, "INSERT INTO zz_session_t VALUES ('x')")
            .await
            .is_err());
        // One statement per call: a text holding two is refused.
        assert!(reg
            .execute(id, "ROLLBACK TO SAVEPOINT s; RELEASE SAVEPOINT s")
            .await
            .is_err());
        reg.execute(id, "ROLLBACK TO SAVEPOINT s").await.unwrap();
        reg.execute(id, "RELEASE SAVEPOINT s").await.unwrap();
        reg.execute(id, "INSERT INTO zz_session_t VALUES (2)")
            .await
            .unwrap();
        assert_eq!(count_rows(&other).await, 0, "not visible before commit");
        reg.end(id, false).await.unwrap();
        assert_eq!(count_rows(&other).await, 0, "rolled back");

        // Committed: both rows stay.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_session_t VALUES (1), (2)")
            .await
            .unwrap();
        reg.end(id, true).await.unwrap();
        assert_eq!(count_rows(&other).await, 2);

        // A snapshot read elsewhere does not see later writes.
        let (sid, snap) = reg
            .begin(conn, &cfg, SqlSessionMode::Snapshot)
            .await
            .unwrap();
        let snap = snap.expect("snapshot id");
        assert!(is_snapshot_id(&snap));
        other
            .batch_execute("INSERT INTO zz_session_t VALUES (3)")
            .await
            .unwrap();
        let mut reader = pool.get().await.unwrap();
        let tx = reader.transaction().await.unwrap();
        tx.batch_execute(&format!(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY; SET TRANSACTION SNAPSHOT '{snap}'"
        ))
        .await
        .unwrap();
        let seen: i64 = tx
            .query_one("SELECT count(*) FROM zz_session_t", &[])
            .await
            .unwrap()
            .get(0);
        tx.rollback().await.unwrap();
        assert_eq!(seen, 2, "the snapshot's state, not the later insert");
        // A connection going away ends its sessions.
        reg.end_for_connection(conn).await;
        assert!(reg.execute(sid, "SELECT 1").await.is_err());

        // Its own connection, closed at the end: a session lock taken by
        // imported SQL does not outlive it, and it needs no pool slot.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "SELECT pg_advisory_lock(424242)")
            .await
            .unwrap();
        reg.end(id, false).await.unwrap();
        let free: bool = other
            .query_one("SELECT pg_try_advisory_lock(424242)", &[])
            .await
            .unwrap()
            .get(0);
        assert!(free, "the advisory lock ended with the session");
        other
            .batch_execute("SELECT pg_advisory_unlock(424242)")
            .await
            .unwrap();

        // Closing a session cuts a running statement short and runs none
        // queued behind it.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        let running = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.execute(id, "SELECT pg_sleep(60)").await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let queued = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move {
                reg.execute(id, "INSERT INTO zz_session_t VALUES (99)")
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        reg.end_for_connection(conn).await;
        let (running, queued) = tokio::join!(running, queued);
        assert!(running.unwrap().is_err());
        assert!(queued.unwrap().is_err());
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "closed promptly"
        );
        let queued_ran: i64 = other
            .query_one("SELECT count(*) FROM zz_session_t WHERE v = 99", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(queued_ran, 0, "the queued statement never ran");

        // A commit asked while a statement runs, then the connection going
        // away: the forced close wins, nothing more runs, nothing commits.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_session_t VALUES (97)")
            .await
            .unwrap();
        let running = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.execute(id, "SELECT pg_sleep(60)").await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let queued = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move {
                reg.execute(id, "INSERT INTO zz_session_t VALUES (98)")
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let ending = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.end(id, true).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        reg.end_for_connection(conn).await;
        let (running, queued, ending) = tokio::join!(running, queued, ending);
        assert!(running.unwrap().is_err());
        assert!(queued.unwrap().is_err());
        assert!(ending.unwrap().is_err(), "the commit lost to the close");
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "closed promptly"
        );
        let kept: i64 = other
            .query_one("SELECT count(*) FROM zz_session_t WHERE v IN (97, 98)", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(kept, 0, "nothing committed, the queued INSERT never ran");

        // An abandoned session is closed by the registry's own watch, even
        // after imported SQL turned the server-side idle timeout off.
        let quick = Arc::new(SqlSessionRegistry {
            sessions: DashMap::new(),
            timing: Timing {
                watch_interval: Duration::from_millis(100),
                // 15 min → 0.9 s
                idle_scale: 0.001,
            },
        });
        let (id, _) = quick
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        quick
            .execute(id, "SET idle_in_transaction_session_timeout = 0")
            .await
            .unwrap();
        quick
            .execute(id, "SELECT pg_advisory_lock(424243)")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(quick.execute(id, "SELECT 1").await.is_err(), "reclaimed");
        let free: bool = other
            .query_one("SELECT pg_try_advisory_lock(424243)", &[])
            .await
            .unwrap()
            .get(0);
        assert!(free, "its lock ended with it");
        other
            .batch_execute("SELECT pg_advisory_unlock(424243)")
            .await
            .unwrap();

        other
            .batch_execute("DROP TABLE zz_session_t")
            .await
            .unwrap();
    }
}
