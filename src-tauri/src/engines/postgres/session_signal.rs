//! Cancel a query or terminate a session from the Health Inspector.
//!
//! One attempt, one pooled client, one read-only transaction, one fixed
//! parameterised statement that matches the target and signals it. The
//! target must still be the same session (PID + backend start token), a
//! client backend in the current database, named, and not one of this
//! process's own connections (see `app_name`). PostgreSQL's own privilege
//! check decides whether the signal is allowed.
//!
//! Nothing here logs the PID, token, query, user or database; outcomes are a
//! closed enum and driver error text is dropped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use deadpool_postgres::{Object, Pool, PoolError};
use serde::Serialize;
use tokio_postgres::types::Type;

/// Time limits for one attempt.
#[derive(Debug, Clone, Copy)]
struct Timing {
    /// Whole operation, from the start of the command to COMMIT.
    deadline: Duration,
    /// Pool acquisition gets at most this much of the deadline.
    acquire: Duration,
}

const TIMING: Timing = Timing {
    deadline: Duration::from_secs(8),
    acquire: Duration::from_secs(5),
};

/// SQLSTATE insufficient_privilege.
const SQLSTATE_INSUFFICIENT_PRIVILEGE: &str = "42501";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalKind {
    Cancel,
    Terminate,
}

impl SignalKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "cancel" => Some(Self::Cancel),
            "terminate" => Some(Self::Terminate),
            _ => None,
        }
    }

    fn sql(self) -> &'static str {
        match self {
            Self::Cancel => CANCEL_SQL,
            Self::Terminate => TERMINATE_SQL,
        }
    }
}

/// Outcome of one attempt. The first four mean the signal was certainly not
/// sent; `Unknown` means it may have been.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalOutcome {
    Invalid,
    Unavailable,
    Busy,
    SetupFailed,
    /// The signal function returned true: signal sent (not proof it took effect).
    Signalled,
    /// The signal function returned false.
    Failed,
    /// No eligible session matched (gone, restarted, unnamed, ours, ...).
    NotMatched,
    /// PostgreSQL refused: not permitted to signal that backend.
    Denied,
    /// The statement may have run but its result or COMMIT is not known.
    Unknown,
}

/// Same expression as the Sessions query, so tokens compare as text.
macro_rules! backend_token_expr {
    () => {
        "pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC', \
         'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
    };
}

macro_rules! signal_sql {
    ($function:literal) => {
        concat!(
            "SELECT pg_catalog.",
            $function,
            "(a.pid) FROM pg_catalog.pg_stat_activity a",
            " WHERE a.pid = $1",
            " AND ",
            backend_token_expr!(),
            " = $2",
            " AND a.datname = pg_catalog.current_database()",
            " AND a.backend_type = 'client backend'",
            " AND a.pid <> pg_catalog.pg_backend_pid()",
            // Not-yet-named or unnamed sessions are ineligible: PostgreSQL
            // publishes a new backend before its application_name.
            " AND NULLIF(a.application_name, '') IS NOT NULL",
            " AND a.application_name IS DISTINCT FROM $3"
        )
    };
}

const CANCEL_SQL: &str = signal_sql!("pg_cancel_backend");
const TERMINATE_SQL: &str = signal_sql!("pg_terminate_backend");

/// Validated target of one attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalTarget {
    pub pid: i32,
    pub backend_token: String,
    pub kind: SignalKind,
}

impl SignalTarget {
    /// `None` for anything outside the contract: PID in 1..=i32::MAX, token in
    /// the server's fixed `YYYY-MM-DDTHH:MI:SS.ffffffZ` shape, known kind.
    pub fn parse(pid: i64, backend_token: &str, kind: &str) -> Option<Self> {
        let pid = i32::try_from(pid).ok().filter(|p| *p > 0)?;
        if !is_backend_token(backend_token) {
            return None;
        }
        Some(Self {
            pid,
            backend_token: backend_token.to_string(),
            kind: SignalKind::parse(kind)?,
        })
    }
}

fn is_backend_token(value: &str) -> bool {
    let bytes = value.as_bytes();
    // 2024-01-02T03:04:05.123456Z
    const SHAPE: &[u8] = b"dddd-dd-ddTdd:dd:dd.ddddddZ";
    bytes.len() == SHAPE.len()
        && bytes.iter().zip(SHAPE).all(|(b, s)| match s {
            b'd' => b.is_ascii_digit(),
            other => b == other,
        })
}

/// Owns the pooled client outside the timed future. Unless disarmed after a
/// clean COMMIT, dropping it detaches the client from the pool and closes it,
/// so a session that may still be inside a transaction is never reused. Runs
/// on deadline, error, panic unwinding and task cancellation alike.
struct DiscardGuard {
    client: Option<Object>,
    armed: bool,
}

impl DiscardGuard {
    fn new(client: Object) -> Self {
        Self {
            client: Some(client),
            armed: true,
        }
    }

    fn client(&mut self) -> &mut Object {
        self.client.as_mut().expect("client present until drop")
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DiscardGuard {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            if self.armed {
                drop(Object::take(client));
            }
        }
    }
}

fn acquisition_outcome(err: &PoolError) -> SignalOutcome {
    match err {
        PoolError::Timeout(_) => SignalOutcome::Busy,
        PoolError::Closed => SignalOutcome::Unavailable,
        PoolError::Backend(_) | PoolError::PostCreateHook(_) | PoolError::NoRuntimeSpecified => {
            SignalOutcome::SetupFailed
        }
    }
}

/// Map the signal statement's rows: exactly one non-null boolean, or none.
fn rows_outcome(values: &[Option<bool>]) -> SignalOutcome {
    match values {
        [] => SignalOutcome::NotMatched,
        [Some(true)] => SignalOutcome::Signalled,
        [Some(false)] => SignalOutcome::Failed,
        _ => SignalOutcome::Unknown,
    }
}

fn statement_error_outcome(err: &tokio_postgres::Error) -> SignalOutcome {
    if err.code().map(|c| c.code()) == Some(SQLSTATE_INSUFFICIENT_PRIVILEGE) {
        SignalOutcome::Denied
    } else {
        // Another server error, a transport error or anything else: the
        // function may already have run.
        SignalOutcome::Unknown
    }
}

/// Phase reached when something went wrong inside the transaction.
enum Failure {
    BeforeDispatch,
    Outcome(SignalOutcome),
}

async fn run_in_transaction(
    client: &mut Object,
    target: &SignalTarget,
    app_name: &str,
    dispatched: &AtomicBool,
) -> Result<SignalOutcome, Failure> {
    let tx = client
        .transaction()
        .await
        .map_err(|_| Failure::BeforeDispatch)?;
    tx.batch_execute(
        "SET TRANSACTION READ ONLY; \
         SET LOCAL statement_timeout = 5000; \
         SET LOCAL lock_timeout = 1000",
    )
    .await
    .map_err(|_| Failure::BeforeDispatch)?;
    let stmt = tx
        .prepare_typed(target.kind.sql(), &[Type::INT4, Type::TEXT, Type::TEXT])
        .await
        .map_err(|_| Failure::BeforeDispatch)?;

    // From here the signal may reach the server.
    dispatched.store(true, Ordering::SeqCst);
    let rows = tx
        .query(&stmt, &[&target.pid, &target.backend_token, &app_name])
        .await
        .map_err(|e| Failure::Outcome(statement_error_outcome(&e)))?;
    let values: Vec<Option<bool>> = rows
        .iter()
        .map(|row| row.try_get::<_, Option<bool>>(0).ok().flatten())
        .collect();
    let outcome = rows_outcome(&values);

    // A known result followed by an unknown COMMIT is still unknown.
    tx.commit()
        .await
        .map_err(|_| Failure::Outcome(SignalOutcome::Unknown))?;
    Ok(outcome)
}

/// Run one attempt against `pool`. Never retries.
pub async fn signal_backend(pool: &Pool, target: &SignalTarget, app_name: &str) -> SignalOutcome {
    signal_backend_with(pool, target, app_name, TIMING).await
}

async fn signal_backend_with(
    pool: &Pool,
    target: &SignalTarget,
    app_name: &str,
    timing: Timing,
) -> SignalOutcome {
    let started = Instant::now();
    let acquire = timing.acquire.min(timing.deadline);
    let client = match tokio::time::timeout(acquire, pool.get()).await {
        Err(_) => return SignalOutcome::Busy,
        Ok(Err(e)) => return acquisition_outcome(&e),
        Ok(Ok(client)) => client,
    };
    let mut guard = DiscardGuard::new(client);
    // One absolute deadline: acquisition time counts against it.
    let remaining = timing.deadline.saturating_sub(started.elapsed());
    let dispatched = AtomicBool::new(false);

    let result = tokio::time::timeout(
        remaining,
        run_in_transaction(guard.client(), target, app_name, &dispatched),
    )
    .await;

    match result {
        Ok(Ok(outcome)) => {
            // Clean COMMIT: the client may go back to the pool.
            guard.disarm();
            outcome
        }
        Ok(Err(Failure::Outcome(outcome))) => outcome,
        Ok(Err(Failure::BeforeDispatch)) => SignalOutcome::SetupFailed,
        Err(_) if dispatched.load(Ordering::SeqCst) => SignalOutcome::Unknown,
        Err(_) => SignalOutcome::SetupFailed,
    }
    // `guard` drops here; armed unless COMMIT succeeded.
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "2026-10-22T03:04:05.123456Z";

    #[test]
    fn parses_only_valid_targets() {
        assert_eq!(
            SignalTarget::parse(4242, TOKEN, "cancel"),
            Some(SignalTarget {
                pid: 4242,
                backend_token: TOKEN.to_string(),
                kind: SignalKind::Cancel,
            })
        );
        assert!(SignalTarget::parse(1, TOKEN, "terminate").is_some());
        assert!(SignalTarget::parse(i64::from(i32::MAX), TOKEN, "cancel").is_some());
        for pid in [0, -1, i64::from(i32::MAX) + 1] {
            assert!(SignalTarget::parse(pid, TOKEN, "cancel").is_none());
        }
        for kind in ["", "Cancel", "kill", "terminate "] {
            assert!(SignalTarget::parse(1, TOKEN, kind).is_none());
        }
        for token in [
            "",
            "2026-10-22T03:04:05.123Z",
            "2026-10-22T03:04:05.123456",
            "2026-10-22 03:04:05.123456Z",
            "2026-10-22T03:04:05.123456+00",
            "2026-10-22T03:04:05.12345'Z",
            "2026-10-22T03:04:05.1234;6Z",
            "2026-10-22T03:04:05.12345\\Z",
            "2026-10-22T03:04:05.12345٦Z",
        ] {
            assert!(SignalTarget::parse(1, token, "cancel").is_none(), "{token}");
        }
    }

    #[test]
    fn statements_keep_every_identity_and_ownership_guard() {
        for (sql, function) in [
            (CANCEL_SQL, "pg_catalog.pg_cancel_backend(a.pid)"),
            (TERMINATE_SQL, "pg_catalog.pg_terminate_backend(a.pid)"),
        ] {
            assert!(sql.starts_with(&format!("SELECT {function} FROM")));
            for guard in [
                "a.pid = $1",
                "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') = $2",
                "a.backend_start AT TIME ZONE 'UTC'",
                "a.datname = pg_catalog.current_database()",
                "a.backend_type = 'client backend'",
                "a.pid <> pg_catalog.pg_backend_pid()",
                "NULLIF(a.application_name, '') IS NOT NULL",
                "a.application_name IS DISTINCT FROM $3",
            ] {
                assert!(sql.contains(guard), "{function}: {guard}");
            }
        }
        assert!(!CANCEL_SQL.contains("terminate"));
        assert!(!TERMINATE_SQL.contains("cancel"));
    }

    #[test]
    fn maps_rows_conservatively() {
        assert_eq!(rows_outcome(&[]), SignalOutcome::NotMatched);
        assert_eq!(rows_outcome(&[Some(true)]), SignalOutcome::Signalled);
        assert_eq!(rows_outcome(&[Some(false)]), SignalOutcome::Failed);
        assert_eq!(rows_outcome(&[None]), SignalOutcome::Unknown);
        assert_eq!(
            rows_outcome(&[Some(true), Some(true)]),
            SignalOutcome::Unknown
        );
    }

    #[test]
    fn maps_pool_errors_to_pre_dispatch_outcomes() {
        use deadpool_postgres::TimeoutType;
        type E = PoolError;
        assert_eq!(
            acquisition_outcome(&E::Timeout(TimeoutType::Wait)),
            SignalOutcome::Busy
        );
        assert_eq!(acquisition_outcome(&E::Closed), SignalOutcome::Unavailable);
        assert_eq!(
            acquisition_outcome(&E::NoRuntimeSpecified),
            SignalOutcome::SetupFailed
        );
    }

    #[test]
    fn outcomes_serialize_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&SignalOutcome::NotMatched).unwrap(),
            "\"not_matched\""
        );
        assert_eq!(
            serde_json::to_string(&SignalOutcome::SetupFailed).unwrap(),
            "\"setup_failed\""
        );
    }

    /// Live checks against a disposable PostgreSQL (never a customer database):
    /// `HEALTH_PG_URL=postgres://user:pass@127.0.0.1:55432/postgres \
    ///  cargo test session_signal_live -- --ignored --test-threads=1`
    /// Creates and drops the role `zz_signal_low` for the permission case.
    mod live {
        use super::super::*;
        use crate::engines::postgres::app_name::postgres_app_name;
        use deadpool_postgres::{Manager, ManagerConfig};
        use tokio_postgres::{Client, Config, NoTls};

        fn base_config() -> Config {
            std::env::var("HEALTH_PG_URL")
                .expect("set HEALTH_PG_URL")
                .parse()
                .expect("valid HEALTH_PG_URL")
        }

        fn pool_with(cfg: Config) -> Pool {
            let mgr = Manager::from_config(cfg, NoTls, ManagerConfig::default());
            Pool::builder(mgr).max_size(2).build().unwrap()
        }

        async fn connect(app_name: &str) -> Client {
            let mut cfg = base_config();
            cfg.application_name(app_name);
            let (client, conn) = cfg.connect(NoTls).await.unwrap();
            tokio::spawn(conn);
            client
        }

        async fn identity(client: &Client) -> (i32, String) {
            let row = client
                .query_one(
                    concat!(
                        "SELECT a.pid, ",
                        backend_token_expr!(),
                        " FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_backend_pid()"
                    ),
                    &[],
                )
                .await
                .unwrap();
            (row.get(0), row.get(1))
        }

        fn target(pid: i32, token: &str, kind: &str) -> SignalTarget {
            SignalTarget::parse(i64::from(pid), token, kind).unwrap()
        }

        #[tokio::test]
        #[ignore]
        async fn session_signal_live() {
            let own = postgres_app_name().unwrap();
            let pool = {
                let mut cfg = base_config();
                cfg.application_name(own);
                pool_with(cfg)
            };

            // Another PoliteDB instance's session: cancellable; its query gets 57014.
            let other = connect("PoliteDB/deadbeef").await;
            let (pid, token) = identity(&other).await;
            let sleeping = tokio::spawn(async move {
                let r = other.simple_query("SELECT pg_sleep(30)").await;
                (other, r)
            });
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(
                signal_backend(&pool, &target(pid, &token, "cancel"), own).await,
                SignalOutcome::Signalled
            );
            let (other, r) = sleeping.await.unwrap();
            assert_eq!(r.unwrap_err().code().map(|c| c.code()), Some("57014"));

            // Stale token (session identity changed) -> not matched.
            let stale = "2000-01-01T00:00:00.000000Z";
            assert_eq!(
                signal_backend(&pool, &target(pid, stale, "cancel"), own).await,
                SignalOutcome::NotMatched
            );

            // This instance's own session -> never matched.
            let mine = connect(own).await;
            let (mine_pid, mine_token) = identity(&mine).await;
            assert_eq!(
                signal_backend(&pool, &target(mine_pid, &mine_token, "terminate"), own).await,
                SignalOutcome::NotMatched
            );
            assert!(!mine.is_closed());

            // Unnamed session -> not eligible.
            let unnamed = connect("").await;
            let (u_pid, u_token) = identity(&unnamed).await;
            assert_eq!(
                signal_backend(&pool, &target(u_pid, &u_token, "terminate"), own).await,
                SignalOutcome::NotMatched
            );
            assert!(!unnamed.is_closed());

            // A renamed own session is no longer protected (accepted gap).
            mine.batch_execute("SET application_name = 'renamed'")
                .await
                .unwrap();
            assert_eq!(
                signal_backend(&pool, &target(mine_pid, &mine_token, "cancel"), own).await,
                SignalOutcome::Signalled
            );

            // Terminate an idle-in-transaction session: its transaction is rolled back.
            other
                .batch_execute("CREATE TABLE IF NOT EXISTS zz_signal_probe(x int)")
                .await
                .unwrap();
            other
                .batch_execute("BEGIN; INSERT INTO zz_signal_probe VALUES (1)")
                .await
                .unwrap();
            assert_eq!(
                signal_backend(&pool, &target(pid, &token, "terminate"), own).await,
                SignalOutcome::Signalled
            );
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(other.simple_query("SELECT 1").await.is_err());
            let probe = connect("PoliteDB/check").await;
            let n: i64 = probe
                .query_one("SELECT count(*) FROM zz_signal_probe", &[])
                .await
                .unwrap()
                .get(0);
            assert_eq!(n, 0);

            // A role without signal rights is denied by PostgreSQL.
            probe
                .batch_execute(
                    "DROP ROLE IF EXISTS zz_signal_low; \
                     CREATE ROLE zz_signal_low LOGIN PASSWORD 'zz_signal_low'",
                )
                .await
                .unwrap();
            let low_pool = {
                let mut cfg = base_config();
                cfg.user("zz_signal_low").password("zz_signal_low");
                cfg.application_name(own);
                pool_with(cfg)
            };
            let (p_pid, p_token) = identity(&probe).await;
            // Without stats visibility the target's start time is masked, so
            // it cannot even be matched.
            assert_eq!(
                signal_backend(&low_pool, &target(p_pid, &p_token, "cancel"), own).await,
                SignalOutcome::NotMatched
            );
            // Visible (pg_read_all_stats) but not allowed to signal a superuser.
            probe
                .batch_execute("GRANT pg_read_all_stats TO zz_signal_low")
                .await
                .unwrap();
            assert_eq!(
                signal_backend(&low_pool, &target(p_pid, &p_token, "cancel"), own).await,
                SignalOutcome::Denied
            );
            low_pool.close();

            // The signalling pool stays usable and settings did not leak.
            let client = pool.get().await.unwrap();
            let ro: String = client
                .query_one("SHOW transaction_read_only", &[])
                .await
                .unwrap()
                .get(0);
            assert_eq!(ro, "off");
            let to: String = client
                .query_one("SHOW statement_timeout", &[])
                .await
                .unwrap()
                .get(0);
            assert_eq!(to, "0");

            probe
                .batch_execute("DROP TABLE zz_signal_probe; DROP ROLE zz_signal_low")
                .await
                .unwrap();
        }

        /// Fault injection through a PostgreSQL wire-protocol proxy (requires
        /// `HEALTH_PG_URL`, disposable database only):
        /// `cargo test session_signal_faults -- --ignored --test-threads=1`
        mod faults {
            use super::super::*;
            use crate::engines::postgres::app_name::postgres_app_name;
            use deadpool_postgres::{Manager, ManagerConfig};
            use std::sync::atomic::AtomicUsize;
            use std::sync::{Arc, Mutex};
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            use tokio::net::{TcpListener, TcpStream};
            use tokio_postgres::config::Host;
            use tokio_postgres::{Client, Config, NoTls};

            #[derive(Clone, Copy, PartialEq, Debug)]
            enum Trigger {
                Begin,
                Bind,
                Commit,
            }

            #[derive(Clone, Copy, PartialEq, Debug)]
            enum Mode {
                Pass,
                StallOn(Trigger),
                DropOn(Trigger),
            }

            /// Forwards client traffic to PostgreSQL, stalling or dropping the
            /// connection when the chosen client message is about to be sent.
            struct Proxy {
                port: u16,
                mode: Arc<Mutex<Mode>>,
                /// Bind messages forwarded (one per extended-protocol execution).
                binds: Arc<AtomicUsize>,
                /// Messages intercepted by a Stall/Drop mode.
                intercepted: Arc<AtomicUsize>,
            }

            impl Proxy {
                async fn start(upstream: (String, u16)) -> Self {
                    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let port = listener.local_addr().unwrap().port();
                    let mode = Arc::new(Mutex::new(Mode::Pass));
                    let binds = Arc::new(AtomicUsize::new(0));
                    let intercepted = Arc::new(AtomicUsize::new(0));
                    let (m, b, i) = (mode.clone(), binds.clone(), intercepted.clone());
                    tokio::spawn(async move {
                        loop {
                            let Ok((client, _)) = listener.accept().await else {
                                return;
                            };
                            let server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                                .await
                                .unwrap();
                            tokio::spawn(pipe(client, server, m.clone(), b.clone(), i.clone()));
                        }
                    });
                    Self {
                        port,
                        mode,
                        binds,
                        intercepted,
                    }
                }

                fn intercepted(&self) -> usize {
                    self.intercepted.load(Ordering::SeqCst)
                }

                fn set(&self, mode: Mode) {
                    *self.mode.lock().unwrap() = mode;
                }

                fn binds(&self) -> usize {
                    self.binds.load(Ordering::SeqCst)
                }
            }

            async fn pipe(
                client: TcpStream,
                server: TcpStream,
                mode: Arc<Mutex<Mode>>,
                binds: Arc<AtomicUsize>,
                intercepted: Arc<AtomicUsize>,
            ) {
                let (mut cr, mut cw) = client.into_split();
                let (mut sr, mut sw) = server.into_split();
                let down = tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut sr, &mut cw).await;
                });
                // Startup phase: untyped length-prefixed messages (SSL/GSS
                // requests, then the startup packet itself).
                loop {
                    let mut len = [0u8; 4];
                    if cr.read_exact(&mut len).await.is_err() {
                        down.abort();
                        return;
                    }
                    let n = u32::from_be_bytes(len) as usize;
                    let mut body = vec![0u8; n - 4];
                    cr.read_exact(&mut body).await.unwrap();
                    sw.write_all(&len).await.unwrap();
                    sw.write_all(&body).await.unwrap();
                    let code = u32::from_be_bytes(body[..4].try_into().unwrap());
                    if code != 80877103 && code != 80877104 {
                        break;
                    }
                }
                // Typed messages.
                loop {
                    let mut head = [0u8; 5];
                    if cr.read_exact(&mut head).await.is_err() {
                        break;
                    }
                    let n = u32::from_be_bytes(head[1..5].try_into().unwrap()) as usize;
                    let mut body = vec![0u8; n - 4];
                    if cr.read_exact(&mut body).await.is_err() {
                        break;
                    }
                    let trigger = match head[0] {
                        // tokio-postgres opens transactions with START TRANSACTION.
                        b'Q' if body.starts_with(b"START TRANSACTION")
                            || body.starts_with(b"BEGIN") =>
                        {
                            Some(Trigger::Begin)
                        }
                        b'Q' if body.starts_with(b"COMMIT") => Some(Trigger::Commit),
                        b'B' => Some(Trigger::Bind),
                        _ => None,
                    };
                    let current = *mode.lock().unwrap();
                    match (current, trigger) {
                        (Mode::StallOn(t), Some(seen)) if t == seen => {
                            intercepted.fetch_add(1, Ordering::SeqCst);
                            // Hold both sockets open and silent.
                            std::future::pending::<()>().await;
                        }
                        (Mode::DropOn(t), Some(seen)) if t == seen => {
                            intercepted.fetch_add(1, Ordering::SeqCst);
                            break;
                        }
                        _ => {}
                    }
                    if head[0] == b'B' {
                        binds.fetch_add(1, Ordering::SeqCst);
                    }
                    if sw.write_all(&head).await.is_err() || sw.write_all(&body).await.is_err() {
                        break;
                    }
                }
                down.abort();
            }

            fn base_config() -> Config {
                std::env::var("HEALTH_PG_URL")
                    .expect("set HEALTH_PG_URL")
                    .parse()
                    .expect("valid HEALTH_PG_URL")
            }

            fn upstream() -> (String, u16) {
                let cfg = base_config();
                let host = match &cfg.get_hosts()[0] {
                    Host::Tcp(h) => h.clone(),
                    #[allow(unreachable_patterns)]
                    _ => "127.0.0.1".to_string(),
                };
                (host, cfg.get_ports().first().copied().unwrap_or(5432))
            }

            fn proxied_pool(proxy: &Proxy, max_size: usize) -> Pool {
                // `Config::host` appends, so build a config that only knows the proxy.
                let base = base_config();
                let mut cfg = Config::new();
                cfg.host("127.0.0.1").port(proxy.port);
                if let Some(user) = base.get_user() {
                    cfg.user(user);
                }
                if let Some(password) = base.get_password() {
                    cfg.password(password);
                }
                if let Some(db) = base.get_dbname() {
                    cfg.dbname(db);
                }
                cfg.application_name(postgres_app_name().unwrap());
                let mgr = Manager::from_config(cfg, NoTls, ManagerConfig::default());
                Pool::builder(mgr).max_size(max_size).build().unwrap()
            }

            async fn direct(app_name: &str) -> Client {
                let mut cfg = base_config();
                cfg.application_name(app_name);
                let (client, conn) = cfg.connect(NoTls).await.unwrap();
                tokio::spawn(conn);
                client
            }

            async fn identity(client: &Client) -> SignalTarget {
                let row = client
                    .query_one(
                        concat!(
                            "SELECT a.pid, ",
                            backend_token_expr!(),
                            " FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_backend_pid()"
                        ),
                        &[],
                    )
                    .await
                    .unwrap();
                let pid: i32 = row.get(0);
                let token: String = row.get(1);
                SignalTarget::parse(i64::from(pid), &token, "cancel").unwrap()
            }

            const FAST: Timing = Timing {
                deadline: Duration::from_millis(1500),
                acquire: Duration::from_millis(1000),
            };

            /// Warm one pooled client so the next call reuses it (size 1).
            async fn warm(pool: &Pool) {
                drop(pool.get().await.unwrap());
                assert_eq!(pool.status().size, 1);
            }

            /// The pool can hand out a fresh, clean client again.
            async fn assert_pool_recovers(pool: &Pool, proxy: &Proxy) {
                proxy.set(Mode::Pass);
                let client = pool.get().await.unwrap();
                let ro: String = client
                    .query_one("SHOW transaction_read_only", &[])
                    .await
                    .unwrap()
                    .get(0);
                assert_eq!(ro, "off");
            }

            #[tokio::test]
            #[ignore]
            async fn session_signal_faults() {
                let own = postgres_app_name().unwrap();
                let proxy = Proxy::start(upstream()).await;
                let other = direct("PoliteDB/deadbeef").await;
                let idle_target = identity(&other).await;

                // Clean COMMIT: the client goes back to the pool (control).
                let pool = proxied_pool(&proxy, 2);
                warm(&pool).await;
                let stale = SignalTarget::parse(
                    i64::from(idle_target.pid),
                    "2000-01-01T00:00:00.000000Z",
                    "cancel",
                )
                .unwrap();
                assert_eq!(
                    signal_backend_with(&pool, &stale, own, FAST).await,
                    SignalOutcome::NotMatched
                );
                assert_eq!(pool.status().size, 1, "clean client returned");

                // BEGIN stalls: deadline before dispatch -> setup_failed, client detached.
                proxy.set(Mode::StallOn(Trigger::Begin));
                let binds = proxy.binds();
                let started = Instant::now();
                assert_eq!(
                    signal_backend_with(&pool, &idle_target, own, FAST).await,
                    SignalOutcome::SetupFailed
                );
                assert!(started.elapsed() < FAST.deadline + Duration::from_millis(400));
                assert_eq!(proxy.binds(), binds, "nothing executed");
                assert_eq!(pool.status().size, 0, "stalled client detached");
                assert_pool_recovers(&pool, &proxy).await;

                // The signal SELECT stalls: possibly dispatched -> unknown, detached.
                let pool = proxied_pool(&proxy, 2);
                warm(&pool).await;
                proxy.set(Mode::StallOn(Trigger::Bind));
                assert_eq!(
                    signal_backend_with(&pool, &idle_target, own, FAST).await,
                    SignalOutcome::Unknown
                );
                assert_eq!(pool.status().size, 0);
                assert_pool_recovers(&pool, &proxy).await;

                // Transport lost at COMMIT after a real signal: unknown, sent once.
                let sleeper = direct("PoliteDB/feedface").await;
                let sleeping_target = identity(&sleeper).await;
                let sleeping = tokio::spawn(async move {
                    let r = sleeper.simple_query("SELECT pg_sleep(30)").await;
                    (sleeper, r)
                });
                tokio::time::sleep(Duration::from_millis(300)).await;
                let pool = proxied_pool(&proxy, 2);
                warm(&pool).await;
                proxy.set(Mode::DropOn(Trigger::Commit));
                let binds = proxy.binds();
                assert_eq!(
                    signal_backend_with(&pool, &sleeping_target, own, FAST).await,
                    SignalOutcome::Unknown
                );
                assert_eq!(proxy.binds(), binds + 1, "exactly one signal statement");
                let (_sleeper, r) = sleeping.await.unwrap();
                assert_eq!(r.unwrap_err().code().map(|c| c.code()), Some("57014"));
                assert_eq!(pool.status().size, 0);
                assert_pool_recovers(&pool, &proxy).await;

                // COMMIT stalls: unknown within the deadline.
                let pool = proxied_pool(&proxy, 2);
                warm(&pool).await;
                proxy.set(Mode::StallOn(Trigger::Commit));
                let started = Instant::now();
                assert_eq!(
                    signal_backend_with(&pool, &stale, own, FAST).await,
                    SignalOutcome::Unknown
                );
                assert!(started.elapsed() < FAST.deadline + Duration::from_millis(400));
                assert_eq!(pool.status().size, 0);
                assert_pool_recovers(&pool, &proxy).await;

                // Task cancelled mid-statement: the guard still detaches the client.
                let pool = proxied_pool(&proxy, 2);
                warm(&pool).await;
                proxy.set(Mode::StallOn(Trigger::Bind));
                let intercepted = proxy.intercepted();
                let task = {
                    let pool = pool.clone();
                    let target = idle_target.clone();
                    tokio::spawn(
                        async move { signal_backend_with(&pool, &target, own, TIMING).await },
                    )
                };
                // Abort only once the signal statement itself is held mid-flight.
                tokio::time::timeout(Duration::from_secs(5), async {
                    while proxy.intercepted() == intercepted {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("Bind intercepted");
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
                assert_eq!(pool.status().size, 0, "aborted attempt detached its client");
                assert_pool_recovers(&pool, &proxy).await;

                // Acquisition counts against the one deadline.
                proxy.set(Mode::Pass);
                let pool = proxied_pool(&proxy, 1);
                let held = pool.get().await.unwrap();
                let started = Instant::now();
                assert_eq!(
                    signal_backend_with(&pool, &stale, own, FAST).await,
                    SignalOutcome::Busy
                );
                assert!(started.elapsed() < FAST.acquire + Duration::from_millis(300));
                // Released after 0.8 s, then BEGIN stalls: total stays ~1.5 s.
                proxy.set(Mode::StallOn(Trigger::Begin));
                let release = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    drop(held);
                });
                let started = Instant::now();
                assert_eq!(
                    signal_backend_with(&pool, &stale, own, FAST).await,
                    SignalOutcome::SetupFailed
                );
                assert!(started.elapsed() < FAST.deadline + Duration::from_millis(400));
                release.await.unwrap();

                // A closed pool is unavailable; nothing is sent.
                proxy.set(Mode::Pass);
                pool.close();
                assert_eq!(
                    signal_backend_with(&pool, &stale, own, FAST).await,
                    SignalOutcome::Unavailable
                );
                drop(other);
            }
        }
    }
}
