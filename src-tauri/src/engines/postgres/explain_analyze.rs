//! EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for the Query Analyzer.
//!
//! Plan: .agent/plans/query-analyzer-explain-analyze.md (approved). The
//! statement runs once, PostgreSQL only, in a read-only transaction that is
//! always rolled back, on a fresh connection that is closed afterwards.
//!
//! - Only read-shaped statements are accepted (`classify_for_analyze`); the
//!   frontend runs the same rules (shared fixtures) and this check wins.
//! - The plan is emitted only after ROLLBACK is acknowledged.
//! - Errors carry fixed categories only; no server text is forwarded.
//! - Nothing here logs SQL, plans, identifiers or server messages: the session
//!   is driven by `connect_quiet`, which drops NOTICEs instead of logging them.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use futures_util::future::poll_fn;
use tauri::Emitter;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_postgres::{Client, Config, NoTls};
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;
use crate::engines::postgres::row_codec;
use crate::operations::ctx::OperationCtx;
use crate::operations::emit::{emit_done, emit_error};
use crate::types::{CellValue, ColumnMeta, TableChunk};

const SETUP_LIMIT: Duration = Duration::from_secs(10);
/// Server statement_timeout is 60 s; the client waits slightly longer.
const QUERY_LIMIT: Duration = Duration::from_secs(62);
const CLEANUP_LIMIT: Duration = Duration::from_secs(5);
const TOTAL_LIMIT: Duration = Duration::from_secs(80);

/* =============================================================================
 * Lexer (mirror of src/lib/sql/pgLexer.ts)
 * ============================================================================= */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Word,
    Str,
    Ident,
    Comment,
    Param,
    Semicolon,
    Other,
}

#[derive(Debug, Clone, Copy)]
struct Token {
    kind: Kind,
    start: usize,
    end: usize,
}

fn is_word_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || (c as u32) >= 0x80
}

fn is_word_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || (c as u32) >= 0x80
}

/// Tokens over `sql` (byte offsets), and whether something was left open.
fn lex(sql: &str) -> (Vec<Token>, bool) {
    let chars: Vec<(usize, char)> = sql.char_indices().collect();
    let n = chars.len();
    let at = |i: usize| chars.get(i).map(|(_, c)| *c);
    let offset = |i: usize| chars.get(i).map(|(o, _)| *o).unwrap_or(sql.len());
    let starts_with = |i: usize, s: &str| sql[offset(i)..].starts_with(s);
    let mut tokens = Vec::new();
    let mut unterminated = false;
    let mut i = 0;

    // Quoted body from i (opening quote); returns the index after the close.
    let quoted = |i: usize, quote: char, backslash: bool, open: &mut bool| -> usize {
        let mut j = i + 1;
        while j < n {
            let c = chars[j].1;
            if backslash && c == '\\' {
                j += 2;
                continue;
            }
            if c == quote {
                if at(j + 1) == Some(quote) {
                    j += 2;
                    continue;
                }
                return j + 1;
            }
            j += 1;
        }
        *open = true;
        n
    };

    while i < n {
        let c = chars[i].1;
        let start = i;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let kind;
        if starts_with(i, "--") {
            while i < n && chars[i].1 != '\n' {
                i += 1;
            }
            kind = Kind::Comment;
        } else if starts_with(i, "/*") {
            let mut depth = 0;
            while i < n {
                if starts_with(i, "/*") {
                    depth += 1;
                    i += 2;
                } else if starts_with(i, "*/") {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            if depth != 0 {
                unterminated = true;
            }
            kind = Kind::Comment;
        } else if (c == 'E' || c == 'e') && at(i + 1) == Some('\'') {
            i = quoted(i + 1, '\'', true, &mut unterminated);
            kind = Kind::Str;
        } else if c == '\'' {
            i = quoted(i, '\'', false, &mut unterminated);
            kind = Kind::Str;
        } else if c == '"' {
            i = quoted(i, '"', false, &mut unterminated);
            kind = Kind::Ident;
        } else if c == '$' {
            // $tag$ (tag may be empty, starts with a letter/_), or $1.
            let mut j = i + 1;
            if at(j).map(is_word_start).unwrap_or(false) {
                j += 1;
                while at(j).map(|ch| ch.is_ascii_alphanumeric() || ch == '_' || (ch as u32) >= 0x80)
                    == Some(true)
                {
                    j += 1;
                }
            }
            if at(j) == Some('$') {
                let tag = &sql[offset(i)..offset(j + 1)];
                match sql[offset(j + 1)..].find(tag) {
                    Some(rel) => {
                        let close = offset(j + 1) + rel + tag.len();
                        i = chars.iter().position(|(o, _)| *o >= close).unwrap_or(n);
                    }
                    None => {
                        unterminated = true;
                        i = n;
                    }
                }
                kind = Kind::Str;
            } else if at(i + 1).map(|ch| ch.is_ascii_digit()).unwrap_or(false) {
                i += 1;
                while at(i).map(|ch| ch.is_ascii_digit()).unwrap_or(false) {
                    i += 1;
                }
                kind = Kind::Param;
            } else {
                i += 1;
                kind = Kind::Other;
            }
        } else if is_word_start(c) {
            i += 1;
            while i < n && is_word_part(chars[i].1) {
                i += 1;
            }
            kind = Kind::Word;
        } else if c == ';' {
            i += 1;
            kind = Kind::Semicolon;
        } else {
            i += 1;
            kind = Kind::Other;
        }
        tokens.push(Token {
            kind,
            start: offset(start),
            end: offset(i),
        });
    }
    (tokens, unterminated)
}

/* =============================================================================
 * Classification
 * ============================================================================= */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalyzeRefusal {
    Empty,
    Unterminated,
    MultipleStatements,
    NotReadOnlyShape,
    Parameters,
    DataChanging,
    RowLock,
}

impl AnalyzeRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Unterminated => "unterminated",
            Self::MultipleStatements => "multiple_statements",
            Self::NotReadOnlyShape => "not_read_only_shape",
            Self::Parameters => "parameters",
            Self::DataChanging => "data_changing",
            Self::RowLock => "row_lock",
        }
    }
}

const LEADING: &[&str] = &["SELECT", "WITH", "VALUES", "TABLE"];

/// Words that are refused anywhere outside strings, comments and quoted
/// identifiers (plan section 1). `END` is not listed: it closes every CASE.
const FORBIDDEN: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "INTO",
    "COPY",
    "CALL",
    "DO",
    "EXECUTE",
    "PREPARE",
    "DEALLOCATE",
    "LOCK",
    "NOTIFY",
    "LISTEN",
    "UNLISTEN",
    "SET",
    "RESET",
    "DISCARD",
    "VACUUM",
    "ANALYZE",
    "CLUSTER",
    "REINDEX",
    "REFRESH",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "COMMENT",
    "SECURITY",
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "ABORT",
    "EXPLAIN",
];

/// The one executable statement to wrap, or why it is refused. The returned
/// text keeps leading comments and drops trailing comments and semicolons.
pub fn classify_for_analyze(sql: &str) -> Result<String, AnalyzeRefusal> {
    let (tokens, unterminated) = lex(sql);
    if unterminated {
        return Err(AnalyzeRefusal::Unterminated);
    }
    let mut statements: Vec<(usize, usize, Vec<Token>)> = Vec::new();
    let mut first: Option<Token> = None;
    let mut last: Option<Token> = None;
    let mut body: Vec<Token> = Vec::new();
    for token in tokens.iter().copied() {
        match token.kind {
            Kind::Semicolon => {
                if let (Some(f), Some(l)) = (first, last) {
                    statements.push((f.start, l.end, std::mem::take(&mut body)));
                }
                first = None;
                last = None;
                body.clear();
            }
            Kind::Comment => {
                if first.is_none() {
                    first = Some(token);
                }
            }
            _ => {
                if first.is_none() {
                    first = Some(token);
                }
                last = Some(token);
                body.push(token);
            }
        }
    }
    if let (Some(f), Some(l)) = (first, last) {
        statements.push((f.start, l.end, body));
    }
    let (start, end, body) = match statements.len() {
        0 => return Err(AnalyzeRefusal::Empty),
        1 => statements.pop().unwrap(),
        _ => return Err(AnalyzeRefusal::MultipleStatements),
    };
    let word = |t: &Token| sql[t.start..t.end].to_ascii_uppercase();
    let leading = body.first().filter(|t| t.kind == Kind::Word).map(word);
    if !leading
        .map(|w| LEADING.contains(&w.as_str()))
        .unwrap_or(false)
    {
        return Err(AnalyzeRefusal::NotReadOnlyShape);
    }
    if body.iter().any(|t| t.kind == Kind::Param) {
        return Err(AnalyzeRefusal::Parameters);
    }
    let words: Vec<String> = body
        .iter()
        .map(|t| {
            if t.kind == Kind::Word {
                word(t)
            } else {
                String::new()
            }
        })
        .collect();
    for (index, w) in words.iter().enumerate() {
        if w == "FOR" {
            let next = words.get(index + 1).map(String::as_str);
            if matches!(next, Some("UPDATE" | "SHARE" | "NO" | "KEY")) {
                return Err(AnalyzeRefusal::RowLock);
            }
        }
    }
    if words.iter().any(|w| FORBIDDEN.contains(&w.as_str())) {
        return Err(AnalyzeRefusal::DataChanging);
    }
    Ok(sql[start..end].to_string())
}

/* =============================================================================
 * Ownership: permit + registry cleanup, dropped on every exit
 * ============================================================================= */

/// One EXPLAIN ANALYZE per runtime connection. Released on drop.
pub struct AnalyzePermit {
    connection_id: Uuid,
    running: Arc<DashMap<Uuid, ()>>,
}

impl AnalyzePermit {
    pub fn acquire(running: &Arc<DashMap<Uuid, ()>>, connection_id: Uuid) -> Option<Self> {
        use dashmap::mapref::entry::Entry;
        match running.entry(connection_id) {
            Entry::Occupied(_) => None,
            Entry::Vacant(slot) => {
                slot.insert(());
                Some(Self {
                    connection_id,
                    running: Arc::clone(running),
                })
            }
        }
    }
}

impl Drop for AnalyzePermit {
    fn drop(&mut self) {
        self.running.remove(&self.connection_id);
    }
}

/// Everything the task owns. Built before spawning and moved into the future
/// by value, so dropping the future (completion, error, or abort even before
/// its first poll) releases the permit and the operation's registry entries.
struct Ownership {
    op_id: Uuid,
    _permit: AnalyzePermit,
    running_ops: Arc<DashMap<Uuid, CancelHandle>>,
    cancel_requested: Arc<DashMap<Uuid, ()>>,
    active_ops: Arc<DashMap<Uuid, ()>>,
    op_to_conn: Arc<DashMap<Uuid, Uuid>>,
    op_tasks: Arc<DashMap<Uuid, tokio::task::JoinHandle<()>>>,
}

impl Drop for Ownership {
    fn drop(&mut self) {
        self.running_ops.remove(&self.op_id);
        self.cancel_requested.remove(&self.op_id);
        self.active_ops.remove(&self.op_id);
        self.op_to_conn.remove(&self.op_id);
        self.op_tasks.remove(&self.op_id);
    }
}

/* =============================================================================
 * Errors
 * ============================================================================= */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Setup,
    Query,
    Cleanup,
}

/// Fixed category for an error; never server text.
pub fn error_category(code: Option<&str>, phase: Phase, app_cancel: bool) -> &'static str {
    match code {
        Some("25006") => "read_only_violation",
        Some("57014") if app_cancel => "cancelled",
        Some("57014") => "timeout",
        Some("55P03") => "lock_timeout",
        Some("42501") => "permission_denied",
        Some("42P01" | "42703" | "42883") => "object_missing",
        Some("42601") => "syntax_error",
        _ => match phase {
            Phase::Setup => "setup_failed",
            Phase::Query => "failed",
            Phase::Cleanup => "rollback_failed",
        },
    }
}

fn pg_code(err: &tokio_postgres::Error) -> Option<&str> {
    err.code().map(|c| c.code())
}

/* =============================================================================
 * Spawn + run
 * ============================================================================= */

/// Spawn the operation. The task waits until its handle is registered, so it
/// can never finish before registration and leave a stale entry.
pub fn spawn(ctx: OperationCtx, config: Config, statement: String, permit: AnalyzePermit) {
    let op_id = ctx.op_id;
    let ownership = Ownership {
        op_id,
        _permit: permit,
        running_ops: Arc::clone(&ctx.running_ops),
        cancel_requested: Arc::clone(&ctx.cancel_requested),
        active_ops: Arc::clone(&ctx.active_ops),
        op_to_conn: Arc::clone(&ctx.op_to_conn),
        op_tasks: Arc::clone(&ctx.op_tasks),
    };
    let op_tasks = Arc::clone(&ctx.op_tasks);
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let _ownership = ownership;
        if registered_rx.await.is_err() {
            return;
        }
        run(ctx, config, statement).await;
    });
    op_tasks.insert(op_id, handle);
    let _ = registered_tx.send(());
}

async fn run(ctx: OperationCtx, config: Config, statement: String) {
    let op_id = ctx.op_id;
    let started = Instant::now();
    let running_ops = Arc::clone(&ctx.running_ops);
    let cancel_requested = Arc::clone(&ctx.cancel_requested);
    let result = execute(
        &config,
        &statement,
        || cancel_requested.contains_key(&op_id),
        |token| {
            running_ops.insert(
                op_id,
                CancelHandle::Postgres {
                    token,
                    backend_pid: -1,
                },
            );
        },
    )
    .await;
    match result {
        Ok((columns, cells)) => {
            let _ = ctx.app.emit(
                "op:chunk_table",
                TableChunk {
                    op_id,
                    columns: Some(columns.clone()),
                    rows: vec![cells],
                    row_offset: 0,
                    seq: 0,
                },
            );
            emit_done(
                &ctx.app,
                op_id,
                false,
                1,
                started.elapsed().as_millis(),
                Some(columns),
            );
        }
        Err(category) => emit_error(
            &ctx.app,
            op_id,
            category.to_string(),
            started.elapsed().as_millis(),
        ),
    }
}

/// Aborts the session's driver task when dropped, which closes the socket;
/// the server then ends the session and rolls back anything still open.
pub(super) struct SessionTask(JoinHandle<()>);

impl SessionTask {
    /// Stops the driver task (closing the socket) without owning the task.
    pub(super) fn abort_handle(&self) -> tokio::task::AbortHandle {
        self.0.abort_handle()
    }
}

impl Drop for SessionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Opens the analysis session from the runtime's settings. Unlike the pool's
/// connector (deadpool spawns `connection.await`, and tokio-postgres then logs
/// every NOTICE and logs connection errors verbatim), this driver task reads
/// asynchronous messages and drops them, and ends silently on error. A
/// statement's functions can put customer data in a NOTICE (plan D6).
pub(super) async fn connect_quiet(
    config: &Config,
) -> Result<(Client, SessionTask), tokio_postgres::Error> {
    let (client, mut connection) = config.connect(NoTls).await?;
    let task = tokio::spawn(async move {
        while let Some(message) = poll_fn(|cx| connection.poll_message(cx)).await {
            if message.is_err() {
                break;
            }
        }
    });
    Ok((client, SessionTask(task)))
}

/// Phase budgets inside the 80 s cap. Setup (connect, BEGIN, settings,
/// prepare) shares one deadline: a slow connect leaves less time to prepare.
struct Budget {
    started: Instant,
    setup_deadline: Instant,
}

impl Budget {
    fn start() -> Self {
        let started = Instant::now();
        Budget {
            started,
            setup_deadline: started + SETUP_LIMIT.min(TOTAL_LIMIT),
        }
    }

    fn total_deadline(&self) -> Instant {
        self.started + TOTAL_LIMIT
    }

    /// `limit` from now, never past the total cap.
    fn phase_deadline(&self, limit: Duration) -> Instant {
        (Instant::now() + limit).min(self.total_deadline())
    }

    async fn setup<T>(&self, step: impl Future<Output = T>) -> Option<T> {
        tokio::time::timeout_at(self.setup_deadline, step)
            .await
            .ok()
    }
}

/// One analysis on a fresh quiet session: setup, query, ROLLBACK, close.
/// Returns the plan row only after the rollback succeeded, otherwise a fixed
/// error category. `cancelled` is checked between phases; `register` receives
/// the session's cancel token as soon as it exists.
pub(crate) async fn execute(
    config: &Config,
    statement: &str,
    cancelled: impl Fn() -> bool,
    register: impl FnOnce(tokio_postgres::CancelToken),
) -> Result<(Vec<ColumnMeta>, Vec<CellValue>), &'static str> {
    let budget = Budget::start();

    // --- Setup: fresh connection, read-only transaction, prepare ----------------
    let (mut client, _session) = match budget.setup(connect_quiet(config)).await {
        Some(Ok(parts)) => parts,
        _ => return Err("connect_failed"),
    };
    let token = client.cancel_token();
    register(token.clone());
    if cancelled() {
        CancelHandle::Postgres {
            token,
            backend_pid: -1,
        }
        .cancel();
        return Err("cancelled");
    }

    let setup = async {
        let tx = client.transaction().await?;
        tx.batch_execute(
            "SET TRANSACTION READ ONLY; \
             SET LOCAL standard_conforming_strings = on; \
             SET LOCAL statement_timeout = 60000; \
             SET LOCAL lock_timeout = 5000",
        )
        .await?;
        let stmt = tx
            .prepare(&format!(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {statement}"
            ))
            .await?;
        Ok::<_, tokio_postgres::Error>((tx, stmt))
    };
    let (tx, stmt) = match budget.setup(setup).await {
        Some(Ok(parts)) => parts,
        Some(Err(e)) => return Err(error_category(pg_code(&e), Phase::Setup, cancelled())),
        None => return Err("timeout"),
    };
    if cancelled() {
        return Err("cancelled");
    }

    // --- Query: run and buffer the single plan row ------------------------------
    let query_deadline = budget.phase_deadline(QUERY_LIMIT);
    let rows = match tokio::time::timeout_at(query_deadline, tx.query(&stmt, &[])).await {
        Ok(Ok(rows)) => rows,
        Ok(Err(e)) => return Err(error_category(pg_code(&e), Phase::Query, cancelled())),
        Err(_) => return Err("timeout"),
    };
    if rows.len() != 1 {
        return Err("failed");
    }
    let (columns, decoders) = row_codec::build_meta_and_decoders(&stmt);
    let cells = row_codec::row_to_cells_with_decoders(&rows[0], &decoders);

    // --- Cleanup: ROLLBACK must be acknowledged before anything is returned -----
    let cleanup_deadline = budget.phase_deadline(CLEANUP_LIMIT);
    match tokio::time::timeout_at(cleanup_deadline, tx.rollback()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(error_category(pg_code(&e), Phase::Cleanup, false)),
        Err(_) => return Err("rollback_failed"),
    }
    drop(client); // closes the session (and `_session` its task); never reused
    Ok((columns, cells))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Fixture {
        sql: String,
        allowed: bool,
        #[serde(default)]
        statement: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    }

    /// Same fixtures as src/lib/sql/analyzeClassify.test.ts.
    #[test]
    fn shared_fixtures_classify_the_same_way() {
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/analyze_classify.json"
        ))
        .expect("fixtures");
        assert!(fixtures.len() > 20);
        for f in fixtures {
            match classify_for_analyze(&f.sql) {
                Ok(statement) => {
                    assert!(f.allowed, "should refuse: {}", f.sql);
                    if let Some(expected) = &f.statement {
                        assert_eq!(&statement, expected, "{}", f.sql);
                    }
                }
                Err(refusal) => {
                    assert!(!f.allowed, "should allow: {} ({:?})", f.sql, refusal);
                    if let Some(reason) = &f.reason {
                        assert_eq!(refusal.code(), reason, "{}", f.sql);
                    }
                }
            }
        }
    }

    #[test]
    fn permit_is_one_per_connection_and_released_on_drop() {
        let running = Arc::new(DashMap::new());
        let id = Uuid::new_v4();
        let first = AnalyzePermit::acquire(&running, id).expect("first");
        assert!(AnalyzePermit::acquire(&running, id).is_none());
        assert!(AnalyzePermit::acquire(&running, Uuid::new_v4()).is_some());
        drop(first);
        assert!(AnalyzePermit::acquire(&running, id).is_some());
    }

    #[test]
    fn errors_map_to_fixed_categories() {
        assert_eq!(
            error_category(Some("25006"), Phase::Query, false),
            "read_only_violation"
        );
        assert_eq!(
            error_category(Some("57014"), Phase::Query, false),
            "timeout"
        );
        assert_eq!(
            error_category(Some("57014"), Phase::Query, true),
            "cancelled"
        );
        assert_eq!(
            error_category(Some("55P03"), Phase::Query, false),
            "lock_timeout"
        );
        assert_eq!(error_category(None, Phase::Setup, false), "setup_failed");
        assert_eq!(
            error_category(Some("XX000"), Phase::Cleanup, false),
            "rollback_failed"
        );
    }

    #[tokio::test]
    async fn aborting_before_the_first_poll_releases_everything() {
        let running = Arc::new(DashMap::new());
        let conn = Uuid::new_v4();
        let op = Uuid::new_v4();
        let op_tasks: Arc<DashMap<Uuid, tokio::task::JoinHandle<()>>> = Arc::new(DashMap::new());
        let active = Arc::new(DashMap::new());
        active.insert(op, ());
        let ownership = Ownership {
            op_id: op,
            _permit: AnalyzePermit::acquire(&running, conn).unwrap(),
            running_ops: Arc::new(DashMap::new()),
            cancel_requested: Arc::new(DashMap::new()),
            active_ops: Arc::clone(&active),
            op_to_conn: Arc::new(DashMap::new()),
            op_tasks: Arc::clone(&op_tasks),
        };
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _ownership = ownership;
            let _ = rx.await;
        });
        handle.abort();
        let _ = handle.await;
        assert!(running.is_empty(), "permit released");
        assert!(active.is_empty(), "registry cleaned");
    }

    #[tokio::test(start_paused = true)]
    async fn setup_steps_share_one_deadline() {
        let budget = Budget::start();
        let slow = || tokio::time::sleep(Duration::from_secs(6));
        assert!(budget.setup(slow()).await.is_some(), "connect within 10 s");
        assert!(
            budget.setup(slow()).await.is_none(),
            "6 s connect + 6 s prepare exceeds the shared 10 s"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn phases_never_pass_the_total_cap() {
        let budget = Budget::start();
        tokio::time::sleep(Duration::from_secs(75)).await;
        assert_eq!(budget.phase_deadline(QUERY_LIMIT), budget.total_deadline());
        assert!(budget.phase_deadline(CLEANUP_LIMIT) <= budget.total_deadline());
    }

    /// Live checks against a disposable PostgreSQL only:
    /// `HEALTH_PG_URL=... cargo test explain_analyze_live -- --ignored --test-threads=1`
    mod live {
        use super::super::*;
        use deadpool_postgres::{Manager, ManagerConfig};
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio_postgres::{Config, NoTls};

        fn config() -> Config {
            std::env::var("HEALTH_PG_URL")
                .expect("set HEALTH_PG_URL")
                .parse()
                .expect("valid url")
        }

        fn pool() -> deadpool_postgres::Pool {
            let mgr = Manager::from_config(config(), NoTls, ManagerConfig::default());
            deadpool_postgres::Pool::builder(mgr)
                .max_size(2)
                .build()
                .unwrap()
        }

        async fn admin(pool: &deadpool_postgres::Pool) -> deadpool_postgres::Object {
            pool.get().await.unwrap()
        }

        fn plan_json(cells: &[CellValue]) -> serde_json::Value {
            match &cells[0] {
                CellValue::Json(s) | CellValue::Str(s) => serde_json::from_str(s).unwrap(),
                other => panic!("unexpected cell {other:?}"),
            }
        }

        #[tokio::test]
        #[ignore]
        async fn explain_analyze_live() {
            let pool = pool();
            let cfg = config();
            let db = admin(&pool).await;
            db.batch_execute(
                "DROP TABLE IF EXISTS zz_ea_rows; CREATE TABLE zz_ea_rows(x int);
                 DROP SEQUENCE IF EXISTS zz_ea_seq; CREATE SEQUENCE zz_ea_seq;
                 CREATE OR REPLACE FUNCTION zz_ea_write() RETURNS int LANGUAGE sql AS
                   'INSERT INTO zz_ea_rows VALUES (1) RETURNING x';",
            )
            .await
            .unwrap();

            // A read statement is measured, with timing and buffers.
            let (_, cells) = execute(
                &cfg,
                "select count(*) from generate_series(1, 1000)",
                || false,
                |_| {},
            )
            .await
            .expect("measured");
            let plan = plan_json(&cells);
            assert!(plan[0]["Execution Time"].is_number());
            assert!(plan[0]["Plan"]["Actual Loops"].is_number());
            assert!(plan[0]["Plan"].get("Shared Hit Blocks").is_some());

            // A function that writes is stopped by the read-only transaction.
            assert_eq!(
                execute(&cfg, "select zz_ea_write()", || false, |_| {})
                    .await
                    .unwrap_err(),
                "read_only_violation"
            );
            let n: i64 = db
                .query_one("select count(*) from zz_ea_rows", &[])
                .await
                .unwrap()
                .get(0);
            assert_eq!(n, 0);

            // nextval on a permanent sequence is refused too; the sequence is untouched.
            assert_eq!(
                execute(&cfg, "select nextval('zz_ea_seq')", || false, |_| {})
                    .await
                    .unwrap_err(),
                "read_only_violation"
            );
            let last: bool = db
                .query_one("select is_called from zz_ea_seq", &[])
                .await
                .unwrap()
                .get(0);
            assert!(!last);

            // standard_conforming_strings is forced on: a backslash is literal.
            let (_, cells) = execute(&cfg, "select 'a\\b' as v", || false, |_| {})
                .await
                .unwrap();
            assert!(plan_json(&cells)[0]["Plan"].is_object());

            // Lock waits stop at lock_timeout.
            let holder = pool.get().await.unwrap();
            holder
                .batch_execute("BEGIN; LOCK TABLE zz_ea_rows IN ACCESS EXCLUSIVE MODE")
                .await
                .unwrap();
            let started = Instant::now();
            assert_eq!(
                execute(&cfg, "select * from zz_ea_rows", || false, |_| {})
                    .await
                    .unwrap_err(),
                "lock_timeout"
            );
            assert!(started.elapsed() < Duration::from_secs(8));
            holder.batch_execute("ROLLBACK").await.unwrap();
            drop(holder);

            // Cancel while running: the server stops the statement.
            let cancel = Arc::new(AtomicBool::new(false));
            let token_slot: Arc<std::sync::Mutex<Option<tokio_postgres::CancelToken>>> =
                Default::default();
            let (c2, t2) = (Arc::clone(&cancel), Arc::clone(&token_slot));
            let cfg2 = cfg.clone();
            let task = tokio::spawn(async move {
                execute(
                    &cfg2,
                    "select pg_sleep(30)",
                    move || c2.load(Ordering::SeqCst),
                    move |t| {
                        *t2.lock().unwrap() = Some(t);
                    },
                )
                .await
            });
            tokio::time::sleep(Duration::from_millis(500)).await;
            cancel.store(true, Ordering::SeqCst);
            let token = token_slot
                .lock()
                .unwrap()
                .clone()
                .expect("token registered");
            token.cancel_query(NoTls).await.unwrap();
            assert_eq!(task.await.unwrap().unwrap_err(), "cancelled");

            // Each analysis used its own connection, now closed; the pool is untouched.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let others: i64 = db
                .query_one(
                    "select count(*) from pg_stat_activity
                     where query like 'EXPLAIN (ANALYZE%' and pid <> pg_backend_pid()",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            assert_eq!(others, 0);
            let ro: String = db
                .query_one("show transaction_read_only", &[])
                .await
                .unwrap()
                .get(0);
            assert_eq!(ro, "off");

            db.batch_execute(
                "DROP FUNCTION zz_ea_write(); DROP TABLE zz_ea_rows; DROP SEQUENCE zz_ea_seq",
            )
            .await
            .unwrap();
        }

        /// Captures `log` records at info and above (tokio-postgres and deadpool
        /// log through `log`). The driver's debug records with SQL text are
        /// dropped by `crate::log_filter`, tested there.
        struct Capture(std::sync::Mutex<Vec<String>>);

        impl log::Log for Capture {
            fn enabled(&self, metadata: &log::Metadata) -> bool {
                metadata.level() <= log::Level::Info
            }
            fn log(&self, record: &log::Record) {
                if self.enabled(record.metadata()) {
                    self.0.lock().unwrap().push(record.args().to_string());
                }
            }
            fn flush(&self) {}
        }

        /// A NOTICE raised by the measured statement (which may carry row data)
        /// never reaches the logs. The pool's default session is the control:
        /// it does log the same notice.
        #[tokio::test]
        #[ignore]
        async fn explain_analyze_notices_are_not_logged() {
            static CAPTURE: Capture = Capture(std::sync::Mutex::new(Vec::new()));
            log::set_logger(&CAPTURE).expect("first logger");
            log::set_max_level(log::LevelFilter::Trace);
            let seen = |marker: &str| {
                CAPTURE
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|line| line.contains(marker))
            };

            let pool = pool();
            let db = admin(&pool).await;
            db.batch_execute(
                "CREATE OR REPLACE FUNCTION zz_ea_notice(t text) RETURNS int LANGUAGE plpgsql AS
                   $$ BEGIN RAISE NOTICE 'customer %', t; RETURN 1; END $$;",
            )
            .await
            .unwrap();

            db.query_one("select zz_ea_notice('control-4111')", &[])
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(
                seen("control-4111"),
                "control: the pool session logs notices"
            );

            let (_, cells) = execute(
                &config(),
                "select zz_ea_notice('secret-4242')",
                || false,
                |_| {},
            )
            .await
            .expect("measured");
            assert!(plan_json(&cells)[0]["Plan"].is_object());
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(!seen("secret-4242"), "analysis session logged a notice");

            // A failing statement whose error text carries data: category only, no log.
            db.batch_execute(
                "CREATE OR REPLACE FUNCTION zz_ea_fail() RETURNS int LANGUAGE plpgsql AS
                   $$ BEGIN RAISE EXCEPTION 'customer secret-5353' USING DETAIL = 'secret-5353', HINT = 'secret-5353'; END $$;",
            )
            .await
            .unwrap();
            assert_eq!(
                execute(&config(), "select zz_ea_fail()", || false, |_| {})
                    .await
                    .unwrap_err(),
                "failed"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(!seen("secret-5353"));

            db.batch_execute("DROP FUNCTION zz_ea_notice(text); DROP FUNCTION zz_ea_fail()")
                .await
                .unwrap();
        }
    }
}
