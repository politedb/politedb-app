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

/// A COMMIT got no answer: it may or may not have been applied.
pub const COMMIT_OUTCOME_UNKNOWN: &str = "The connection closed while committing, so whether the changes were applied is unknown. Check the database before running this again.";

const OPEN: u8 = 0;
/// end() was asked: no statement starts.
const ENDING: u8 = 1;
/// end() owns the connection and sends COMMIT/ROLLBACK.
const COMMITTING: u8 = 2;
/// Closed by a cancel, or by a forced close (the connection going away, a
/// timeout): nothing more is sent. Who closed it is part of the state, set
/// by the same compare-exchange that takes it, so it is never seen closed
/// without its owner.
const CLOSED_BY_CANCEL: u8 = 3;
const CLOSED_FORCED: u8 = 4;

fn is_closed(state: u8) -> bool {
    state == CLOSED_BY_CANCEL || state == CLOSED_FORCED
}

/// What a cancel established. Each says only that this side has closed
/// the session's connection and that no COMMIT was sent by end() — never
/// that the server confirmed a rollback.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    /// This cancel took the session and its teardown finished.
    Cancelled,
    /// Another cancel of this session took it; its teardown finished.
    AlreadyClosedByCancel,
    /// It was closed by end() or a forced close: no evidence about COMMIT.
    AlreadyEnded,
    /// No such session (never opened, or ended and gone): no evidence.
    Unknown,
}

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
    /// OPEN → ENDING → COMMITTING, or OPEN/ENDING → CLOSED_BY_CANCEL /
    /// CLOSED_FORCED. Past OPEN no statement starts. Each step is taken by
    /// compare-exchange, so exactly one of end(), a cancel and a forced
    /// close owns the outcome: a close that wins sends nothing; one that
    /// comes after COMMIT was sent leaves its outcome unknown, and says so.
    state: std::sync::atomic::AtomicU8,
    /// None once ended. Dropping it closes the connection; the server then
    /// rolls back anything still open.
    client: Mutex<Option<(Client, SessionTask)>>,
    last_used: std::sync::Mutex<Instant>,
    /// Taken by the one caller that tears the session down.
    teardown_started: std::sync::atomic::AtomicBool,
    /// True once torn down (connection closed, client dropped, unlisted).
    /// Until then the session stays listed as closed, so a late cancel or
    /// end() sees it ended instead of not found.
    torn_down: tokio::sync::watch::Sender<bool>,
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
    #[cfg(test)]
    hooks: TestHooks,
}

/// Lets a test hold a step (gates) and see where calls are (counters), to
/// order races by handshakes rather than sleeps.
#[cfg(test)]
#[derive(Default)]
struct TestHooks {
    /// Held at the start of a teardown.
    teardown_gate: Gate,
    /// Held right after a cancel took the session, before its teardown.
    cancel_took_gate: Gate,
    /// Held right after end() moved OPEN → ENDING, before it waits for the
    /// client.
    ending_gate: Gate,
    /// Teardowns actually run (not waits on another's).
    teardowns: std::sync::atomic::AtomicUsize,
    /// execute() calls that reached the client lock (waiting or holding).
    at_lock: std::sync::atomic::AtomicUsize,
    /// Statements sent to the server.
    sent: std::sync::atomic::AtomicUsize,
    /// Cancels that took the session (passed their compare-exchange).
    cancels_took: std::sync::atomic::AtomicUsize,
    /// end() calls past OPEN → ENDING.
    endings: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
#[derive(Default)]
struct Gate(std::sync::Mutex<Option<Arc<tokio::sync::Semaphore>>>);

#[cfg(test)]
impl Gate {
    /// Closes the gate: each pass then needs one permit.
    fn hold(&self) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *self.0.lock().unwrap() = Some(Arc::clone(&gate));
        gate
    }

    fn open(&self) {
        *self.0.lock().unwrap() = None;
    }

    async fn pass(&self) {
        let gate = self.0.lock().unwrap().clone();
        if let Some(gate) = gate {
            let _ = gate.acquire().await.map(|p| p.forget());
        }
    }
}

#[cfg(test)]
impl TestHooks {
    async fn before_teardown(&self) {
        self.teardowns.fetch_add(1, SeqCst);
        self.teardown_gate.pass().await;
    }

    async fn after_cancel_took(&self) {
        self.cancels_took.fetch_add(1, SeqCst);
        self.cancel_took_gate.pass().await;
    }

    async fn after_ending(&self) {
        self.endings.fetch_add(1, SeqCst);
        self.ending_gate.pass().await;
    }
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
            #[cfg(test)]
            hooks: TestHooks::default(),
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
                teardown_started: std::sync::atomic::AtomicBool::new(false),
                torn_down: tokio::sync::watch::channel(false).0,
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
        #[cfg(test)]
        self.hooks.at_lock.fetch_add(1, SeqCst);
        let result = {
            let guard = session.client.lock().await;
            // Closed while this call waited for the lock.
            if session.state.load(SeqCst) != OPEN {
                return Err("SQL_SESSION_ENDED".into());
            }
            let (client, _) = guard.as_ref().ok_or("SQL_SESSION_ENDED")?;
            #[cfg(test)]
            self.hooks.sent.fetch_add(1, SeqCst);
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
    /// connection going away, a timeout) can still find and stop it. A
    /// close that gets there before COMMITTING means nothing is sent; once
    /// COMMIT is sent, a close cannot undo it, and a COMMIT left without an
    /// answer is reported as of unknown outcome.
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
            // Already ending, or closed: a close is torn down before this
            // answers, so the caller never sees it half done.
            if is_closed(session.state.load(SeqCst)) {
                Self::wait_torn_down(&session).await;
            }
            return Err("SQL_SESSION_ENDED".into());
        }
        #[cfg(test)]
        self.hooks.after_ending().await;
        let result = match tokio::time::timeout(END_LIMIT, session.client.lock()).await {
            // A statement still running past the limit: close instead.
            Err(_) => Err("SQL_SESSION_END_TIMEOUT".to_string()),
            Ok(mut guard) => {
                // Take ownership of the outcome; a forced close that got
                // there first means nothing is sent.
                if session
                    .state
                    .compare_exchange(ENDING, COMMITTING, SeqCst, SeqCst)
                    .is_err()
                {
                    // A cancel or forced close took it: that caller tears
                    // it down; nothing is sent from here.
                    drop(guard);
                    Self::wait_torn_down(&session).await;
                    return Err("SQL_SESSION_ENDED".into());
                } else if let Some((client, _task)) = guard.take() {
                    let end = if commit { "COMMIT" } else { "ROLLBACK" };
                    match tokio::time::timeout(END_LIMIT, client.batch_execute(end)).await {
                        Ok(Ok(())) => Ok(()),
                        // The server answered: the transaction is over,
                        // not committed.
                        Ok(Err(e)) if e.as_db_error().is_some() => Err(format_pg_error(&e, end)),
                        // No answer (the connection closed, or no reply in
                        // time): a COMMIT may or may not have been applied.
                        _ if commit => Err(COMMIT_OUTCOME_UNKNOWN.into()),
                        _ => Err("SQL_SESSION_ROLLBACK_FAILED".into()),
                    }
                } else {
                    Ok(())
                }
            }
        };
        if result.is_err() {
            self.close(session_id).await;
        } else {
            // Answered: nothing is running, so no server cancel.
            self.teardown(session_id, &session, false).await;
        }
        result
    }

    /// Cancels a session: unless end() already sent COMMIT or ROLLBACK
    /// (COMMITTING, refused without touching anything), its connection is
    /// closed at once and a running statement cancelled, and it returns
    /// once that teardown has finished. Repeated or concurrent cancels wait
    /// for the same teardown.
    pub async fn cancel(&self, session_id: Uuid) -> Result<CancelOutcome, String> {
        let Some(session) = self.sessions.get(&session_id).map(|s| Arc::clone(&s)) else {
            return Ok(CancelOutcome::Unknown);
        };
        let took = session.state.fetch_update(SeqCst, SeqCst, |state| {
            (state == OPEN || state == ENDING).then_some(CLOSED_BY_CANCEL)
        });
        let state = match took {
            Ok(_) => {
                #[cfg(test)]
                self.hooks.after_cancel_took().await;
                self.teardown(session_id, &session, true).await;
                return Ok(CancelOutcome::Cancelled);
            }
            Err(state) => state,
        };
        if state == COMMITTING {
            return Err("SQL_SESSION_COMMITTING".into());
        }
        Self::wait_torn_down(&session).await;
        Ok(if state == CLOSED_BY_CANCEL {
            CancelOutcome::AlreadyClosedByCancel
        } else {
            CancelOutcome::AlreadyEnded
        })
    }

    /// Ends a session without waiting on a statement still running: the
    /// connection closes at once and the statement is cancelled. Unless
    /// end() already sent COMMIT (COMMITTING), the server rolls back what
    /// the session held and an ending in progress sends nothing.
    async fn close(&self, session_id: Uuid) {
        let Some(session) = self.sessions.get(&session_id).map(|s| Arc::clone(&s)) else {
            return;
        };
        // Own the session unless end() already owns the outcome (its
        // COMMIT is in flight): the connection still closes below.
        let _ = session.state.fetch_update(SeqCst, SeqCst, |state| {
            (state == OPEN || state == ENDING).then_some(CLOSED_FORCED)
        });
        self.teardown(session_id, &session, true).await;
    }

    /// Closes the session's connection, once, whoever asks: the first
    /// caller does it and later ones wait for it. The session stays listed
    /// until it is done.
    async fn teardown(&self, session_id: Uuid, session: &Arc<PgSqlSession>, cancel_server: bool) {
        if session.teardown_started.swap(true, SeqCst) {
            Self::wait_torn_down(session).await;
            return;
        }
        #[cfg(test)]
        self.hooks.before_teardown().await;
        // Close the connection now, without waiting for the lock a running
        // statement or an ending may hold: that work then fails.
        session.abort.abort();
        if cancel_server {
            // The server may not notice the closed socket while a statement
            // runs: ask it to cancel too, without waiting on that.
            let cancel = session.cancel.clone();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(CANCEL_LIMIT, cancel.cancel_query(NoTls)).await;
            });
        }
        let taken = match tokio::time::timeout(END_LIMIT, session.client.lock()).await {
            Ok(mut guard) => guard.take(),
            Err(_) => None,
        };
        drop(taken);
        self.sessions.remove(&session_id);
        session.torn_down.send_replace(true);
    }

    async fn wait_torn_down(session: &PgSqlSession) {
        let mut done = session.torn_down.subscribe();
        let _ = done.wait_for(|done| *done).await;
    }

    /// Closes every session of a connection that is going away (rolled
    /// back, unless a COMMIT was already sent).
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
            hooks: TestHooks::default(),
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

    /// Waits until `cond` holds (a handshake, not a timed guess).
    async fn until(what: &str, cond: impl Fn() -> bool) {
        for _ in 0..1000 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for: {what}");
    }

    fn state_of(reg: &SqlSessionRegistry, id: Uuid) -> Option<u8> {
        reg.sessions.get(&id).map(|s| s.state.load(SeqCst))
    }

    /// Cancelling sessions, against a disposable PostgreSQL:
    /// `HEALTH_PG_URL=… cargo test sql_session_cancel_live -- --ignored`
    /// Creates and drops the table `zz_cancel_t` and its trigger function.
    /// Races are ordered by gates and counters (TestHooks), not sleeps.
    #[tokio::test]
    #[ignore]
    async fn sql_session_cancel_live() {
        use deadpool_postgres::{Manager, ManagerConfig};

        let cfg: tokio_postgres::Config = std::env::var("HEALTH_PG_URL")
            .expect("set HEALTH_PG_URL")
            .parse()
            .expect("valid HEALTH_PG_URL");
        let pool = deadpool_postgres::Pool::builder(Manager::from_config(
            cfg.clone(),
            NoTls,
            ManagerConfig::default(),
        ))
        .max_size(2)
        .build()
        .unwrap();
        let other = pool.get().await.unwrap();
        other
            .batch_execute(
                "DROP TABLE IF EXISTS zz_cancel_t; CREATE TABLE zz_cancel_t (v int);
                 CREATE OR REPLACE FUNCTION zz_cancel_slow() RETURNS trigger
                   LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NULL; END $$;
                 CREATE CONSTRAINT TRIGGER zz_cancel_slow AFTER INSERT ON zz_cancel_t
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
                   WHEN (NEW.v >= 500) EXECUTE FUNCTION zz_cancel_slow();",
            )
            .await
            .unwrap();
        let rows = |v: i32| {
            let other = &other;
            async move {
                other
                    .query_one("SELECT count(*) FROM zz_cancel_t WHERE v = $1", &[&v])
                    .await
                    .unwrap()
                    .get::<_, i64>(0)
            }
        };
        let conn = Uuid::new_v4();
        let reg = Arc::new(SqlSessionRegistry::default());
        let h = &reg.hooks;

        // A running statement is cut short, and one queued behind it never
        // runs; nothing stays and the session's locks are released.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_cancel_t VALUES (1)")
            .await
            .unwrap();
        reg.execute(id, "SELECT pg_advisory_lock(434343)")
            .await
            .unwrap();
        let (at_lock, sent) = (h.at_lock.load(SeqCst), h.sent.load(SeqCst));
        let running = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.execute(id, "SELECT pg_sleep(60)").await })
        };
        until("the sleep is sent", || h.sent.load(SeqCst) == sent + 1).await;
        let queued = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.execute(id, "INSERT INTO zz_cancel_t VALUES (2)").await })
        };
        until("the insert waits for the lock", || {
            h.at_lock.load(SeqCst) == at_lock + 2
        })
        .await;
        let started = Instant::now();
        assert_eq!(reg.cancel(id).await, Ok(CancelOutcome::Cancelled));
        assert!(running.await.unwrap().is_err());
        assert_eq!(
            queued.await.unwrap(),
            Err("SQL_SESSION_ENDED".to_string()),
            "the queued statement never ran"
        );
        assert_eq!(h.sent.load(SeqCst), sent + 1);
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "cancelled promptly"
        );
        assert_eq!(rows(1).await + rows(2).await, 0, "not committed");
        let mut free = false;
        for _ in 0..50 {
            free = other
                .query_one("SELECT pg_try_advisory_lock(434343)", &[])
                .await
                .unwrap()
                .get(0);
            if free {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(free, "its lock was released");
        other
            .batch_execute("SELECT pg_advisory_unlock(434343)")
            .await
            .unwrap();
        // Later calls see it gone, never a fresh session.
        assert!(reg.execute(id, "SELECT 1").await.is_err());
        assert!(reg.end(id, true).await.is_err());
        assert_eq!(reg.cancel(id).await, Ok(CancelOutcome::Unknown));

        // A cancel that took the session (held before its teardown), then a
        // forced close and a second cancel: the owner is never lost, the
        // teardown runs once, and everyone answers after it.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        let took_gate = h.cancel_took_gate.hold();
        let (took, teardowns) = (h.cancels_took.load(SeqCst), h.teardowns.load(SeqCst));
        let first = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.cancel(id).await })
        };
        until("the first cancel took it", || {
            h.cancels_took.load(SeqCst) == took + 1
        })
        .await;
        assert_eq!(state_of(&reg, id), Some(CLOSED_BY_CANCEL));
        let teardown_gate = h.teardown_gate.hold();
        let forced = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.end_for_connection(conn).await })
        };
        until("the forced close holds the teardown", || {
            h.teardowns.load(SeqCst) == teardowns + 1
        })
        .await;
        let second = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.cancel(id).await })
        };
        let ending = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.end(id, true).await })
        };
        // Nobody answers while the teardown is held.
        tokio::task::yield_now().await;
        assert!(!second.is_finished() && !ending.is_finished() && !forced.is_finished());
        assert_eq!(state_of(&reg, id), Some(CLOSED_BY_CANCEL), "owner kept");
        h.teardown_gate.open();
        teardown_gate.add_permits(1);
        h.cancel_took_gate.open();
        took_gate.add_permits(1);
        forced.await.unwrap();
        assert_eq!(first.await.unwrap(), Ok(CancelOutcome::Cancelled));
        assert_eq!(
            second.await.unwrap(),
            Ok(CancelOutcome::AlreadyClosedByCancel)
        );
        assert_eq!(ending.await.unwrap(), Err("SQL_SESSION_ENDED".to_string()));
        assert_eq!(h.teardowns.load(SeqCst), teardowns + 1, "torn down once");
        assert_eq!(state_of(&reg, id), None);

        // An end() already ENDING (held there) loses to a cancel: it sends
        // nothing, does not close again, and answers after the teardown.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_cancel_t VALUES (3)")
            .await
            .unwrap();
        let ending_gate = h.ending_gate.hold();
        let (endings, teardowns) = (h.endings.load(SeqCst), h.teardowns.load(SeqCst));
        let ending = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.end(id, true).await })
        };
        until("end() is ENDING", || h.endings.load(SeqCst) == endings + 1).await;
        assert_eq!(state_of(&reg, id), Some(ENDING));
        assert_eq!(reg.cancel(id).await, Ok(CancelOutcome::Cancelled));
        h.ending_gate.open();
        ending_gate.add_permits(1);
        assert_eq!(ending.await.unwrap(), Err("SQL_SESSION_ENDED".to_string()));
        assert_eq!(h.teardowns.load(SeqCst), teardowns + 1, "torn down once");
        assert_eq!(rows(3).await, 0, "no COMMIT was sent");

        // A forced close is no evidence for a cancel arriving during it.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        let teardown_gate = h.teardown_gate.hold();
        let teardowns = h.teardowns.load(SeqCst);
        let forced = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.end_for_connection(conn).await })
        };
        until("the forced close holds the teardown", || {
            h.teardowns.load(SeqCst) == teardowns + 1
        })
        .await;
        assert_eq!(state_of(&reg, id), Some(CLOSED_FORCED));
        let late = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.cancel(id).await })
        };
        tokio::task::yield_now().await;
        assert!(!late.is_finished());
        h.teardown_gate.open();
        teardown_gate.add_permits(1);
        forced.await.unwrap();
        assert_eq!(late.await.unwrap(), Ok(CancelOutcome::AlreadyEnded));

        // Once COMMIT is sent (slowed by a deferred trigger), a cancel is
        // refused and changes nothing: the commit completes.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_cancel_t VALUES (500)")
            .await
            .unwrap();
        let committing = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.end(id, true).await })
        };
        until("COMMIT is sent", || state_of(&reg, id) == Some(COMMITTING)).await;
        assert_eq!(
            reg.cancel(id).await,
            Err("SQL_SESSION_COMMITTING".to_string())
        );
        assert_eq!(committing.await.unwrap(), Ok(()));
        assert_eq!(rows(500).await, 1, "committed");
        // Gone after a completed end: unknown, not a cancel.
        assert_eq!(reg.cancel(id).await, Ok(CancelOutcome::Unknown));

        // The connection going away during a COMMIT in flight: the forced
        // close cannot take the session from end(), which reports the
        // outcome as unknown (the existing contract), and tears down once.
        let (id, _) = reg
            .begin(conn, &cfg, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_cancel_t VALUES (501)")
            .await
            .unwrap();
        let teardowns = h.teardowns.load(SeqCst);
        let committing = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.end(id, true).await })
        };
        until("COMMIT is sent", || state_of(&reg, id) == Some(COMMITTING)).await;
        reg.end_for_connection(conn).await;
        assert_eq!(
            committing.await.unwrap(),
            Err(COMMIT_OUTCOME_UNKNOWN.to_string())
        );
        assert_eq!(h.teardowns.load(SeqCst), teardowns + 1, "torn down once");
        assert_eq!(state_of(&reg, id), None);

        // The server may still finish that COMMIT; wait for it before the
        // cleanup so the drop does not block on its lock.
        tokio::time::sleep(Duration::from_secs(4)).await;
        other
            .batch_execute("DROP TABLE zz_cancel_t; DROP FUNCTION zz_cancel_slow()")
            .await
            .unwrap();
    }
}
