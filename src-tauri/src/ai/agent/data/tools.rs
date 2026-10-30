//! The data tools offered to the model (plan ai-agent R4): `sample_rows`,
//! `run_readonly_query`, `explain_query`.
//!
//! Every call goes through the same steps, in order: the connection is still open;
//! the user's data-access consent holds (else the run stops with
//! `AI_DATA_ACCESS_REQUIRED` before the database is touched); the SQL passes
//! [`query_guard`]; on PostgreSQL the catalog shows only built-in code is reachable; in
//! safe/production mode the user approves this exact SQL natively (a denial stops the
//! run). Only then does the query run, read-only, on a session nobody else uses.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use super::{DataExecutor, MAX_QUERY_ROWS, MAX_SAMPLE_ROWS};
use crate::ai::agent::catalog::tools::{ensure_admitted, Admission, Alive};
use crate::ai::agent::catalog::CatalogExecutor;
use crate::ai::agent::consent::DATA_ACCESS_REQUIRED;
use crate::ai::agent::protocol::ToolSpec;
use crate::ai::agent::query_guard::{self, GuardDialect, MAX_QUERY_BYTES, NOT_ALLOWED};
use crate::ai::agent::run::{AgentTool, ToolContext, ToolError, ToolOutput};

pub const APPROVAL_DENIED: &str = "AI_DATA_APPROVAL_DENIED";
/// SQL shown in the approval prompt.
const APPROVAL_SQL_CHARS: usize = 200;

/// Native confirmation of one data query by the user (macOS LocalAuthentication).
#[async_trait]
pub trait ApprovalPort: Send + Sync {
    /// `Ok(true)` only when the user approved.
    async fn approve(&self, reason: &str) -> Result<bool, String>;
}

/// Everything the data tools need for one run on one connection.
pub struct DataAccess {
    pub executor: Arc<dyn DataExecutor>,
    pub catalog: Arc<dyn CatalogExecutor>,
    pub alive: Alive,
    /// Whether the connection may take new work (not stale): checked before
    /// every tool touches it, and again after the approval wait.
    pub admission: Admission,
    /// Whether the user's consent for this connection and provider holds right now.
    pub consent: Arc<dyn Fn() -> bool + Send + Sync>,
    /// `Some` in safe/production mode: every query needs approval.
    pub approval: Option<Arc<dyn ApprovalPort>>,
    /// Connection name for the approval prompt.
    pub label: String,
    /// Set once data from this connection may be in the transcript.
    pub provenance: Arc<AtomicBool>,
}

pub fn tools(access: Arc<DataAccess>) -> Vec<Arc<dyn AgentTool>> {
    vec![
        Arc::new(SampleRows(access.clone())),
        Arc::new(RunQuery(access.clone())),
        Arc::new(ExplainQuery(access)),
    ]
}

/// Strict arguments: an object with only `fields`, each a string or (for `limit`) an
/// integer in `1..=max_limit`.
fn parse(
    arguments: &Value,
    strings: &[(&str, bool, usize)],
    max_limit: Option<usize>,
) -> Result<(Map<String, Value>, usize), ToolError> {
    let object = arguments
        .as_object()
        .ok_or_else(|| ToolError::from("arguments must be an object"))?;
    let known = |key: &str| {
        strings.iter().any(|(name, _, _)| *name == key) || (key == "limit" && max_limit.is_some())
    };
    if object.keys().any(|key| !known(key)) {
        return Err("unexpected argument".into());
    }
    for (name, required, max) in strings {
        match object.get(*name) {
            None | Some(Value::Null) if !required => {}
            Some(Value::String(text)) if !text.trim().is_empty() && text.len() <= *max => {}
            _ => return Err(format!("invalid argument: {name}").into()),
        }
    }
    let limit = match (max_limit, object.get("limit")) {
        (Some(max), None | Some(Value::Null)) => max,
        (Some(max), Some(value)) => match value.as_u64() {
            Some(n) if n >= 1 && n as usize <= max => n as usize,
            _ => return Err(format!("invalid argument: limit (1 to {max})").into()),
        },
        (None, _) => 0,
    };
    Ok((object.clone(), limit))
}

fn text<'a>(args: &'a Map<String, Value>, name: &str) -> &'a str {
    args.get(name).and_then(Value::as_str).unwrap_or("").trim()
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl DataAccess {
    /// The checks every data query passes before it runs; returns the SQL to execute.
    async fn admit(&self, sql: &str, ctx: &ToolContext) -> Result<String, ToolError> {
        if !(self.alive)() {
            return Err("the database connection was closed".into());
        }
        ensure_admitted(&self.admission)?;
        if !(self.consent)() {
            return Err(ToolError::Stop(DATA_ACCESS_REQUIRED.into()));
        }
        let validated = query_guard::validate(sql, self.executor.dialect())?;
        if self.executor.dialect() == GuardDialect::Postgres
            && !self.catalog.only_builtin_code(ctx).await.unwrap_or(false)
        {
            return Err(format!(
                "{NOT_ALLOWED}: this database has user-defined functions, operators or views \
                 that automatic queries cannot run against; suggest the SQL instead"
            )
            .into());
        }
        if let Some(approval) = &self.approval {
            let shown: String = validated.chars().take(APPROVAL_SQL_CHARS).collect();
            let more = if validated.chars().count() > APPROVAL_SQL_CHARS {
                "…"
            } else {
                ""
            };
            let reason = format!(
                "Allow the AI agent to read data from {}?\n\n{shown}{more}",
                self.label
            );
            // A cancelled run drops the prompt (the native adapter dismisses it).
            let approved = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => return Err("canceled".into()),
                answer = approval.approve(&reason) => answer.unwrap_or(false),
            };
            if !approved {
                return Err(ToolError::Stop(APPROVAL_DENIED.into()));
            }
        }
        // The waits above (catalog check, approval) may have outlived the connection,
        // the profile's target or the consent: check them again right before reading.
        if !(self.alive)() {
            return Err("the database connection was closed".into());
        }
        ensure_admitted(&self.admission)?;
        if !(self.consent)() {
            return Err(ToolError::Stop(DATA_ACCESS_REQUIRED.into()));
        }
        if ctx.cancel.is_cancelled() {
            return Err("canceled".into());
        }
        // From here on, results or errors may carry data.
        self.provenance.store(true, Ordering::SeqCst);
        Ok(validated)
    }

    async fn rows(
        &self,
        sql: &str,
        limit: usize,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let validated = self.admit(sql, ctx).await?;
        let rows = self.executor.query(&validated, limit, ctx).await?;
        let count = rows.rows.len();
        Ok(ToolOutput {
            content: json!({ "rows": rows.rows, "row_count": count, "truncated": rows.truncated })
                .to_string(),
            truncated: rows.truncated,
        })
    }
}

fn integer_limit(max: usize) -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": max })
}

fn sql_param(description: &str) -> Value {
    json!({ "type": "string", "description": description, "maxLength": MAX_QUERY_BYTES })
}

struct SampleRows(Arc<DataAccess>);

#[async_trait]
impl AgentTool for SampleRows {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "sample_rows".into(),
            description: "Read a few rows of one table or view to see what its data looks like."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "schema": { "type": "string", "maxLength": 128 },
                    "table": { "type": "string", "maxLength": 128 },
                    "limit": integer_limit(MAX_SAMPLE_ROWS),
                },
                "required": ["schema", "table"],
                "additionalProperties": false
            }),
        }
    }

    async fn run(&self, arguments: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let (args, limit) = parse(
            &arguments,
            &[("schema", true, 128), ("table", true, 128)],
            Some(MAX_SAMPLE_ROWS),
        )?;
        let (schema, table) = (text(&args, "schema"), text(&args, "table"));
        // Admitted before even the catalog read below touches the connection.
        ensure_admitted(&self.0.admission)?;
        // Only a table the catalog knows; its name is then quoted, never interpolated.
        let described = self.0.catalog.describe_table(schema, table, ctx).await?;
        let sql = match self.0.executor.dialect() {
            GuardDialect::Postgres => format!(
                "SELECT * FROM {}.{}",
                quote_ident(&described.schema),
                quote_ident(&described.name)
            ),
            GuardDialect::Sqlite => format!("SELECT * FROM {}", quote_ident(&described.name)),
        };
        self.0.rows(&sql, limit, ctx).await
    }
}

struct RunQuery(Arc<DataAccess>);

#[async_trait]
impl AgentTool for RunQuery {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "run_readonly_query".into(),
            description: format!(
                "Run one read-only SELECT and get up to {MAX_QUERY_ROWS} rows. Only plain \
                 queries with built-in functions are allowed; anything else is rejected with \
                 a reason. Use it only when the answer needs actual data."
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "sql": sql_param("One SELECT (or WITH … SELECT) statement"),
                    "limit": integer_limit(MAX_QUERY_ROWS),
                },
                "required": ["sql"],
                "additionalProperties": false
            }),
        }
    }

    async fn run(&self, arguments: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let (args, limit) = parse(
            &arguments,
            &[("sql", true, MAX_QUERY_BYTES)],
            Some(MAX_QUERY_ROWS),
        )?;
        self.0.rows(text(&args, "sql"), limit, ctx).await
    }
}

struct ExplainQuery(Arc<DataAccess>);

#[async_trait]
impl AgentTool for ExplainQuery {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "explain_query".into(),
            description: "Show the query plan of one read-only SELECT without running it.".into(),
            parameters: json!({
                "type": "object",
                "properties": { "sql": sql_param("One SELECT (or WITH … SELECT) statement") },
                "required": ["sql"],
                "additionalProperties": false
            }),
        }
    }

    async fn run(&self, arguments: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let (args, _) = parse(&arguments, &[("sql", true, MAX_QUERY_BYTES)], None)?;
        let validated = self.0.admit(text(&args, "sql"), ctx).await?;
        let plan = self.0.executor.explain(&validated, ctx).await?;
        Ok(ToolOutput::from(json!({ "plan": plan }).to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::catalog::{Column, TableDescription, TableRef, TABLE_NOT_FOUND};
    use crate::ai::agent::data::Rows;
    use std::sync::Mutex;
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    #[derive(Default)]
    struct FakeData {
        dialect: Option<GuardDialect>,
        ran: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DataExecutor for FakeData {
        fn dialect(&self) -> GuardDialect {
            self.dialect.unwrap_or(GuardDialect::Postgres)
        }
        async fn query(&self, sql: &str, limit: usize, _: &ToolContext) -> Result<Rows, String> {
            self.ran.lock().unwrap().push(sql.to_string());
            Ok(Rows {
                rows: (0..limit.min(3)).map(|i| json!({ "id": i })).collect(),
                truncated: limit < 3,
            })
        }
        async fn explain(&self, sql: &str, _: &ToolContext) -> Result<String, String> {
            self.ran.lock().unwrap().push(format!("EXPLAIN {sql}"));
            Ok("Seq Scan".into())
        }
    }

    struct FakeCatalog {
        builtin_only: bool,
    }

    #[async_trait]
    impl CatalogExecutor for FakeCatalog {
        fn dialect(&self) -> &'static str {
            "PostgreSQL"
        }
        fn sql_engine(&self) -> &'static str {
            "postgres"
        }
        async fn list_schemas(&self, _: &ToolContext) -> Result<Vec<String>, String> {
            Ok(vec![])
        }
        async fn list_tables(
            &self,
            _: Option<&str>,
            _: Option<&str>,
            _: &ToolContext,
        ) -> Result<Vec<TableRef>, String> {
            Ok(vec![])
        }
        async fn describe_table(
            &self,
            schema: &str,
            table: &str,
            _: &ToolContext,
        ) -> Result<TableDescription, String> {
            if table != "my \"orders\"" {
                return Err(TABLE_NOT_FOUND.into());
            }
            Ok(TableDescription {
                schema: schema.into(),
                name: table.into(),
                columns: vec![Column {
                    name: "id".into(),
                    data_type: "int".into(),
                    nullable: false,
                    default: None,
                    primary_key: true,
                    comment: None,
                }],
                foreign_keys: vec![],
                indexes: vec![],
                truncated: false,
            })
        }
        async fn only_builtin_code(&self, _: &ToolContext) -> Result<bool, String> {
            Ok(self.builtin_only)
        }
    }

    struct FakeApproval {
        answer: bool,
        asked: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ApprovalPort for FakeApproval {
        async fn approve(&self, reason: &str) -> Result<bool, String> {
            self.asked.lock().unwrap().push(reason.to_string());
            Ok(self.answer)
        }
    }

    struct Setup {
        data: Arc<FakeData>,
        provenance: Arc<AtomicBool>,
        tools: Vec<Arc<dyn AgentTool>>,
    }

    fn setup(consent: bool, builtin_only: bool, approval: Option<Arc<FakeApproval>>) -> Setup {
        setup_with(
            Arc::new(AtomicBool::new(consent)),
            builtin_only,
            approval.map(|a| a as Arc<dyn ApprovalPort>),
        )
    }

    fn setup_with(
        consent: Arc<AtomicBool>,
        builtin_only: bool,
        approval: Option<Arc<dyn ApprovalPort>>,
    ) -> Setup {
        setup_admitted(consent, builtin_only, approval, Arc::new(|| Ok(())))
    }

    fn setup_admitted(
        consent: Arc<AtomicBool>,
        builtin_only: bool,
        approval: Option<Arc<dyn ApprovalPort>>,
        admission: Admission,
    ) -> Setup {
        let data = Arc::new(FakeData::default());
        let provenance = Arc::new(AtomicBool::new(false));
        let access = Arc::new(DataAccess {
            executor: data.clone(),
            catalog: Arc::new(FakeCatalog { builtin_only }),
            alive: Arc::new(|| true),
            admission,
            consent: Arc::new(move || consent.load(Ordering::SeqCst)),
            approval,
            label: "Prod DB".into(),
            provenance: provenance.clone(),
        });
        Setup {
            data,
            provenance,
            tools: tools(access),
        }
    }

    async fn call(setup: &Setup, name: &str, args: Value) -> Result<ToolOutput, ToolError> {
        let tool = setup.tools.iter().find(|t| t.spec().name == name).unwrap();
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        tool.run(args, &ctx).await
    }

    #[tokio::test]
    async fn a_stale_connection_ends_the_run_before_any_read() {
        let s = setup_admitted(
            Arc::new(AtomicBool::new(true)),
            true,
            None,
            Arc::new(|| Err("RUNTIME_STALE".to_string())),
        );
        for (tool, args) in [
            ("run_readonly_query", json!({ "sql": "SELECT 1" })),
            (
                "sample_rows",
                json!({ "schema": "public", "table": "my \"orders\"" }),
            ),
            ("explain_query", json!({ "sql": "SELECT 1" })),
        ] {
            assert_eq!(
                call(&s, tool, args).await.unwrap_err(),
                ToolError::Stop("RUNTIME_STALE".into()),
                "{tool}"
            );
        }
        assert!(s.data.ran.lock().unwrap().is_empty());
        assert!(!s.provenance.load(Ordering::SeqCst));
    }

    /// The profile is saved again while the user is asked to approve.
    struct StaleWhileAsked {
        stale: Arc<AtomicBool>,
    }

    #[async_trait]
    impl ApprovalPort for StaleWhileAsked {
        async fn approve(&self, _: &str) -> Result<bool, String> {
            self.stale.store(true, Ordering::SeqCst);
            Ok(true)
        }
    }

    #[tokio::test]
    async fn a_connection_stale_after_approval_is_not_read() {
        let stale = Arc::new(AtomicBool::new(false));
        let s = setup_admitted(
            Arc::new(AtomicBool::new(true)),
            true,
            Some(Arc::new(StaleWhileAsked {
                stale: stale.clone(),
            })),
            {
                let stale = stale.clone();
                Arc::new(move || {
                    if stale.load(Ordering::SeqCst) {
                        Err("RUNTIME_STALE".to_string())
                    } else {
                        Ok(())
                    }
                })
            },
        );
        assert_eq!(
            call(&s, "run_readonly_query", json!({ "sql": "SELECT 1" }))
                .await
                .unwrap_err(),
            ToolError::Stop("RUNTIME_STALE".into())
        );
        assert!(s.data.ran.lock().unwrap().is_empty());
        assert!(!s.provenance.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn without_consent_the_run_stops_before_the_database() {
        let s = setup(false, true, None);
        for (tool, args) in [
            ("run_readonly_query", json!({ "sql": "SELECT 1" })),
            (
                "sample_rows",
                json!({ "schema": "public", "table": "my \"orders\"" }),
            ),
            ("explain_query", json!({ "sql": "SELECT 1" })),
        ] {
            assert_eq!(
                call(&s, tool, args).await.unwrap_err(),
                ToolError::Stop(DATA_ACCESS_REQUIRED.into())
            );
        }
        assert!(s.data.ran.lock().unwrap().is_empty());
        assert!(!s.provenance.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn rejected_sql_and_untrusted_catalogs_never_run() {
        let s = setup(true, true, None);
        let err = call(&s, "run_readonly_query", json!({ "sql": "DELETE FROM t" }))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Failed(ref r) if r.starts_with(NOT_ALLOWED)));
        let untrusted = setup(true, false, None);
        let err = call(
            &untrusted,
            "run_readonly_query",
            json!({ "sql": "SELECT 1" }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ToolError::Failed(ref r) if r.contains("user-defined")));
        assert!(s.data.ran.lock().unwrap().is_empty());
        assert!(untrusted.data.ran.lock().unwrap().is_empty());
        assert!(!untrusted.provenance.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn approval_shows_the_exact_sql_and_a_denial_stops_the_run() {
        let denied = Arc::new(FakeApproval {
            answer: false,
            asked: Mutex::new(vec![]),
        });
        let s = setup(true, true, Some(denied.clone()));
        let err = call(
            &s,
            "run_readonly_query",
            json!({ "sql": "SELECT id FROM orders -- hi" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, ToolError::Stop(APPROVAL_DENIED.into()));
        let asked = denied.asked.lock().unwrap().clone();
        assert!(asked[0].contains("Prod DB") && asked[0].contains("SELECT id FROM orders"));
        assert!(!asked[0].contains("hi"), "the prompt shows what would run");
        assert!(s.data.ran.lock().unwrap().is_empty());

        let approved = Arc::new(FakeApproval {
            answer: true,
            asked: Mutex::new(vec![]),
        });
        let s = setup(true, true, Some(approved.clone()));
        let out = call(
            &s,
            "run_readonly_query",
            json!({ "sql": "SELECT id FROM orders", "limit": 2 }),
        )
        .await
        .unwrap();
        assert!(out.truncated);
        assert_eq!(
            *s.data.ran.lock().unwrap(),
            vec!["SELECT id FROM orders".to_string()]
        );
        assert_eq!(approved.asked.lock().unwrap().len(), 1);
        assert!(s.provenance.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn sample_rows_reads_only_catalogued_tables_by_quoted_name() {
        let s = setup(true, true, None);
        call(
            &s,
            "sample_rows",
            json!({ "schema": "public", "table": "my \"orders\"" }),
        )
        .await
        .unwrap();
        assert_eq!(
            *s.data.ran.lock().unwrap(),
            vec!["SELECT * FROM \"public\".\"my \"\"orders\"\"\"".to_string()]
        );
        let err = call(
            &s,
            "sample_rows",
            json!({ "schema": "public", "table": "x; DROP TABLE t" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, ToolError::Failed(TABLE_NOT_FOUND.into()));
        let explained = call(&s, "explain_query", json!({ "sql": "SELECT 1" }))
            .await
            .unwrap();
        assert!(explained.content.contains("Seq Scan"));
    }

    #[tokio::test]
    async fn arguments_are_strict() {
        let s = setup(true, true, None);
        for (tool, args) in [
            (
                "run_readonly_query",
                json!({ "sql": "SELECT 1", "limit": 0 }),
            ),
            (
                "run_readonly_query",
                json!({ "sql": "SELECT 1", "limit": MAX_QUERY_ROWS + 1 }),
            ),
            (
                "run_readonly_query",
                json!({ "sql": "SELECT 1", "limit": "5" }),
            ),
            (
                "run_readonly_query",
                json!({ "sql": "SELECT 1", "extra": 1 }),
            ),
            ("run_readonly_query", json!({ "sql": "" })),
            (
                "sample_rows",
                json!({ "schema": "public", "table": "t", "limit": 21 }),
            ),
            ("explain_query", json!({ "sql": "SELECT 1", "limit": 5 })),
        ] {
            assert!(
                matches!(
                    call(&s, tool, args.clone()).await,
                    Err(ToolError::Failed(_))
                ),
                "{tool} {args}"
            );
        }
        assert!(s.data.ran.lock().unwrap().is_empty());
    }

    /// Revokes consent while the approval prompt is open, then approves.
    struct RevokingApproval(Arc<AtomicBool>);

    #[async_trait]
    impl ApprovalPort for RevokingApproval {
        async fn approve(&self, _: &str) -> Result<bool, String> {
            self.0.store(false, Ordering::SeqCst);
            Ok(true)
        }
    }

    #[tokio::test]
    async fn consent_lost_while_approving_stops_before_reading() {
        let consent = Arc::new(AtomicBool::new(true));
        let s = setup_with(
            consent.clone(),
            true,
            Some(Arc::new(RevokingApproval(consent))),
        );
        let err = call(&s, "run_readonly_query", json!({ "sql": "SELECT 1" }))
            .await
            .unwrap_err();
        assert_eq!(err, ToolError::Stop(DATA_ACCESS_REQUIRED.into()));
        assert!(s.data.ran.lock().unwrap().is_empty());
        assert!(!s.provenance.load(Ordering::SeqCst));
    }

    /// Never answers; records that its future was dropped (the prompt dismissed).
    struct OpenPrompt(Arc<AtomicBool>);

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl ApprovalPort for OpenPrompt {
        async fn approve(&self, _: &str) -> Result<bool, String> {
            let _flag = DropFlag(self.0.clone());
            std::future::pending::<()>().await;
            Ok(true)
        }
    }

    #[tokio::test]
    async fn cancelling_the_run_drops_a_pending_approval() {
        let dropped = Arc::new(AtomicBool::new(false));
        let s = setup_with(
            Arc::new(AtomicBool::new(true)),
            true,
            Some(Arc::new(OpenPrompt(dropped.clone()))),
        );
        let tool = s
            .tools
            .iter()
            .find(|t| t.spec().name == "run_readonly_query")
            .unwrap();
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        let stopper = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            stopper.cancel();
        });
        let err = tool
            .run(json!({ "sql": "SELECT 1" }), &ctx)
            .await
            .unwrap_err();
        assert_eq!(err, ToolError::Failed("canceled".into()));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(s.data.ran.lock().unwrap().is_empty());
    }
}
