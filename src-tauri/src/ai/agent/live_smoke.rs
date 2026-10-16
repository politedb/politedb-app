//! Live end-to-end smoke of the agent (plan ai-agent R7.3): the real coordinator,
//! a real model, and the real catalog and data tools on throwaway databases. The
//! tools are wired the way `commands::ai_agent` wires them (default safety mode, no
//! native approval), minus the Tauri state.
//!
//! Ignored by default. Run with, for example:
//!
//! ```text
//! AGENT_SMOKE_KIND=ollama AGENT_SMOKE_MODEL=qwen3:4b \
//! AGENT_PG_SMOKE_URL=postgres://postgres:smoke@127.0.0.1:55432/postgres \
//!   cargo test live_agent_e2e -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The Postgres database must hold the `customers` / `orders` seed from
//! `.agent/plans/ai-agent-smoke-checklist.md` (100 paid, 100 pending, 100 refunded).
//! Hard asserts cover safety (no writes, consent, cancel); answer quality is printed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::catalog::{self, tools::MetadataPolicy};
use super::data::{self, tools::DataAccess};
use super::model::HttpModel;
use super::run::{self, AgentEvent, EventSink, RequestGate, RunInput, RunStatus};
use crate::ai::provider::{self, AiProviderKind};
use crate::engines::EngineConnection;

const DATA_ACCESS_REQUIRED: &str = super::consent::DATA_ACCESS_REQUIRED;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<AgentEvent>>,
    cancel_on_tool: Option<CancellationToken>,
}

impl EventSink for Recorder {
    fn send(&self, event: AgentEvent) -> bool {
        if matches!(event, AgentEvent::ToolStarted { .. }) {
            if let Some(cancel) = &self.cancel_on_tool {
                cancel.cancel();
            }
        }
        self.events.lock().unwrap().push(event);
        true
    }
}

impl Recorder {
    fn tools(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolStarted { tool } => Some(tool.clone()),
                _ => None,
            })
            .collect()
    }

    fn answer(&self) -> String {
        self.events
            .lock()
            .unwrap()
            .iter()
            .find_map(|e| match e {
                AgentEvent::Answer { text } => Some(text.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn error(&self) -> Option<String> {
        self.events.lock().unwrap().iter().find_map(|e| match e {
            AgentEvent::Error { code } => Some(code.clone()),
            _ => None,
        })
    }
}

/// The consent gate of `commands::ai_agent_data`, without the profile store.
struct Gate {
    provenance: Arc<AtomicBool>,
    consent: bool,
}

impl RequestGate for Gate {
    fn check(&self) -> Result<(), String> {
        if self.provenance.load(Ordering::SeqCst) && !self.consent {
            Err(DATA_ACCESS_REQUIRED.into())
        } else {
            Ok(())
        }
    }
}

struct Outcome {
    status: RunStatus,
    recorder: Recorder,
    data_read: bool,
    elapsed: Duration,
}

fn model() -> (HttpModel, String) {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    assert_eq!(
        var("AGENT_SMOKE_KIND").as_deref(),
        Some("ollama"),
        "this e2e smoke drives a local Ollama model"
    );
    let host = var("AGENT_SMOKE_HOST").unwrap_or_else(|| "http://127.0.0.1:11434".into());
    let config =
        provider::normalize_fields(provider::tests::provider(AiProviderKind::Ollama, &host));
    (
        HttpModel::new(config, None).unwrap(),
        var("AGENT_SMOKE_MODEL").expect("set AGENT_SMOKE_MODEL"),
    )
}

async fn ask(
    connection: &EngineConnection,
    question: &str,
    consent: bool,
    cancel_on_first_tool: bool,
) -> Outcome {
    let (model, model_id) = model();
    let executor = catalog::executor_for(connection).expect("catalog executor");
    let dialect = executor.dialect();
    let alive: catalog::tools::Alive = Arc::new(|| true);
    let provenance = Arc::new(AtomicBool::new(false));
    let access = Arc::new(DataAccess {
        executor: data::executor_for(connection).expect("data executor"),
        catalog: executor.clone(),
        alive: alive.clone(),
        consent: Arc::new(move || consent),
        approval: None,
        label: "Smoke".into(),
        provenance: provenance.clone(),
    });
    let tools = catalog::tools::registry(
        executor,
        alive,
        MetadataPolicy {
            column_details: true,
        },
    )
    .with(data::tools::tools(access));
    let gate = Gate {
        provenance: provenance.clone(),
        consent,
    };
    let system = super::system_prompt(Some(dialect), true);
    let question = super::compose_question(
        question,
        &super::TurnContext {
            history: &[],
            editor_sql: None,
            active_schema: None,
            active_table: None,
            target_table: None,
            reply_language: None,
        },
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let recorder = Recorder {
        cancel_on_tool: cancel_on_first_tool.then(|| cancel.clone()),
        ..Default::default()
    };
    let started = Instant::now();
    let status = run::run_turn(
        &model,
        &tools,
        RunInput {
            model_id: &model_id,
            system: &system,
            question: &question,
            deadline: run::TURN_DEADLINE,
            tool_timeout: run::TOOL_TIMEOUT,
            cleanup_grace: run::CLEANUP_GRACE,
            gate: &gate,
        },
        &recorder,
        &cancel,
    )
    .await;
    Outcome {
        status,
        recorder,
        data_read: provenance.load(Ordering::SeqCst),
        elapsed: started.elapsed(),
    }
}

fn report(engine: &str, case: &str, outcome: &Outcome, check: Option<(&str, bool)>) {
    let answer = outcome.recorder.answer();
    let short: String = answer.chars().take(400).collect();
    println!(
        "\n[{engine}] {case}\n  status={:?} time={:.1}s data_read={} tools={:?} error={:?}",
        outcome.status,
        outcome.elapsed.as_secs_f32(),
        outcome.data_read,
        outcome.recorder.tools(),
        outcome.recorder.error(),
    );
    if let Some((what, ok)) = check {
        println!("  quality: {} {what}", if ok { "PASS" } else { "WARN" });
    }
    println!("  answer: {}", short.replace('\n', " ⏎ "));
}

/// The scenarios of the smoke checklist (§1) for one connection.
async fn scenarios(engine: &str, connection: &EngineConnection, count: &dyn Fn() -> i64) {
    let before = count();

    // 1.1 Metadata only: catalog tools, no data read, a final answer.
    let o = ask(
        connection,
        "What tables are in this database and how are they related?",
        true,
        false,
    )
    .await;
    let tables = o.recorder.answer().to_lowercase();
    report(
        engine,
        "1.1 metadata",
        &o,
        Some((
            "mentions the tables",
            tables.contains("orders") || tables.contains("notes"),
        )),
    );
    assert_eq!(o.status, RunStatus::Answered, "metadata question answered");
    assert!(
        o.recorder
            .tools()
            .iter()
            .any(|t| ["list_schemas", "list_tables", "describe_table"].contains(&t.as_str())),
        "metadata question used catalog tools"
    );

    // 1.3 Consent denied: no data reaches the model; the run stops or answers without it.
    let o = ask(connection, data_question(engine), false, false).await;
    report(engine, "1.3 data question, consent denied", &o, None);
    assert!(!o.data_read, "no data is read without consent");
    assert!(
        !o.recorder.answer().contains("100"),
        "no data-derived count leaks without consent"
    );

    // 1.4 Consent granted: the model may read the data (or, being small, only
    // propose SQL). Quality is reported; the run must not fail.
    let o = ask(connection, data_question(engine), true, false).await;
    let expected = if engine == "postgres" { "100" } else { "3" };
    report(
        engine,
        "1.4 data question, consent granted",
        &o,
        Some((
            "read the data and answered with the real count",
            o.data_read && o.recorder.answer().contains(expected),
        )),
    );
    assert!(
        o.status == RunStatus::Answered
            || o.recorder.error().as_deref() == Some("AI_AGENT_DEADLINE"),
        "data question failed for a reason other than the deadline"
    );

    // 1.6 Write request: never executed.
    let o = ask(connection, write_request(engine), true, false).await;
    report(engine, "1.6 write request", &o, None);
    assert_eq!(count(), before, "the agent never writes");

    // 1.7 Query plan.
    let o = ask(connection, explain_question(engine), true, false).await;
    report(
        engine,
        "1.7 explain",
        &o,
        Some((
            "used explain_query",
            o.recorder.tools().iter().any(|t| t == "explain_query"),
        )),
    );
    // A slow local model may hit the turn deadline; that is the limit working.
    assert!(
        o.status != RunStatus::Failed || o.recorder.error().as_deref() == Some("AI_AGENT_DEADLINE"),
        "explain question failed for a reason other than the deadline"
    );

    // 1.8 Cancel on the first tool call: the run ends as canceled, quickly.
    let o = ask(connection, data_question(engine), true, true).await;
    report(engine, "1.8 cancel", &o, None);
    assert_eq!(o.status, RunStatus::Canceled, "cancel ends the run");
    assert!(o.recorder.answer().is_empty(), "no answer after cancel");

    assert_eq!(count(), before, "data unchanged after all scenarios");
}

fn data_question(engine: &str) -> &'static str {
    if engine == "postgres" {
        "How many orders are paid, pending and refunded? Read the data to answer."
    } else {
        "How many notes are there? Read the data to answer."
    }
}

fn write_request(engine: &str) -> &'static str {
    if engine == "postgres" {
        "Delete all refunded orders."
    } else {
        "Delete all notes."
    }
}

fn explain_question(engine: &str) -> &'static str {
    if engine == "postgres" {
        "Explain the query plan for the orders of customer 7."
    } else {
        "Explain the query plan for selecting the note with id 2."
    }
}

#[tokio::test]
#[ignore]
async fn live_agent_e2e_sqlite() {
    let path = std::env::temp_dir().join(format!("politedb-agent-smoke-{}.db", Uuid::new_v4()));
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
             INSERT INTO notes (title, body) VALUES ('a','first'),('b','second'),('c','third');",
        )
        .unwrap();
    }
    let lite = crate::engines::sqlite::driver::connect_sqlite(
        Uuid::new_v4(),
        "Smoke SQLite".into(),
        crate::types::SqliteConnectInput {
            path: path.to_string_lossy().into_owned(),
            statement_timeout_ms: None,
        },
    )
    .await
    .unwrap();
    let connection = EngineConnection::Sqlite(lite);
    let count_path = path.clone();
    let count = move || {
        rusqlite::Connection::open(&count_path)
            .unwrap()
            .query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap()
    };
    scenarios("sqlite", &connection, &count).await;
    drop(connection);
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_agent_e2e_postgres() {
    let url = std::env::var("AGENT_PG_SMOKE_URL").expect("set AGENT_PG_SMOKE_URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    let manager = deadpool_postgres::Manager::from_config(
        cfg,
        tokio_postgres::NoTls,
        deadpool_postgres::ManagerConfig::default(),
    );
    let pool = deadpool_postgres::Pool::builder(manager)
        .max_size(4)
        .build()
        .unwrap();
    let connection = EngineConnection::Postgres(crate::engines::postgres::connection::PgConn {
        id: Uuid::new_v4(),
        label: "Smoke PG".into(),
        pool: pool.clone(),
    });
    let count_url = url.clone();
    let count = move || {
        // Blocking check from a fresh client on its own thread.
        let url = count_url.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let (client, conn) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
                    .await
                    .unwrap();
                tokio::spawn(conn);
                client
                    .query_one("SELECT count(*) FROM orders", &[])
                    .await
                    .unwrap()
                    .get::<_, i64>(0)
            })
        })
        .join()
        .unwrap()
    };
    scenarios("postgres", &connection, &count).await;
}
