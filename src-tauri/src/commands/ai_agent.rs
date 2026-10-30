//! Thin commands for the AI agent; the coordinator lives in `crate::ai::agent`.

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::ai::adapters::{AppProviderFiles, AppSecrets};
use crate::ai::agent::consent::DATA_ACCESS_REQUIRED;
use crate::ai::agent::model::{CapabilityCache, CapabilityKey, TOOLS_UNSUPPORTED};
use crate::ai::agent::prepare::{self, PrepareInput};
use crate::ai::agent::run::{self, AgentEvent, EventSink, RunInput, ToolRegistry};
use crate::ai::agent::sql_safety::{self, SqlSafety};
use crate::ai::agent::start::{self, RunSnapshot};
use crate::ai::agent::{self, catalog};
use crate::license;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartInput {
    /// Client-generated id used to cancel the run.
    pub run_id: String,
    pub provider_id: String,
    pub model: Option<String>,
    pub question: String,
    /// Runtime connection the metadata tools read (plan R3). Without one the run has
    /// no tools.
    pub connection_id: Option<String>,
    /// Current SQL editor text, sent only when the user's "sql" context chip is on.
    pub editor_sql: Option<String>,
    /// Visible earlier messages of this chat; bounded again by `compose_question`.
    #[serde(default)]
    pub history: Vec<agent::HistoryEntry>,
    pub active_schema: Option<String>,
    pub active_table: Option<String>,
    pub target_table: Option<String>,
    pub reply_language: Option<String>,
    /// Send column comments and defaults to the provider (plan R3). Off unless the
    /// frontend says so.
    #[serde(default)]
    pub include_column_details: bool,
    /// The editor's query safety mode for this connection (plan R5). Missing or
    /// unknown counts as `lock`: no data tools.
    pub safety_mode: Option<String>,
    /// The chat already holds answers built from this connection's data. The run then
    /// sends nothing unless data-access consent holds for this provider (plan R5).
    #[serde(default)]
    pub history_has_data: bool,
}

/// The connection's engine has no agent tools in v1: use the legacy assistant.
pub const ENGINE_UNSUPPORTED: &str = "AI_AGENT_ENGINE_UNSUPPORTED";
/// Agent mode and its data access need Pro (or a running trial).
pub const AGENT_PRO_REQUIRED: &str = "AI_AGENT_PRO_REQUIRED";

/// Forwards events to the frontend and remembers models that cannot use tools.
struct ChannelSink {
    channel: Channel<AgentEvent>,
    capabilities: Arc<CapabilityCache>,
    capability_key: CapabilityKey,
}

impl EventSink for ChannelSink {
    fn send(&self, event: AgentEvent) -> bool {
        if matches!(&event, AgentEvent::Error { code } if code == TOOLS_UNSUPPORTED) {
            self.capabilities.record(self.capability_key.clone(), false);
        }
        self.channel.send(event).is_ok()
    }

    fn tools_accepted(&self) {
        self.capabilities.record(self.capability_key.clone(), true);
    }
}

/// Starts a run and returns immediately; progress arrives on `on_event`. Fails up front
/// (nothing sent anywhere) for unknown/disabled providers, providers without a verified
/// tool-calling contract, models known to lack tools, duplicate ids or too many runs.
#[tauri::command]
pub async fn ai_agent_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    input: AgentStartInput,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    // Agent mode is a Pro feature; checked before any provider or database work.
    license::require_pro(&app, AGENT_PRO_REQUIRED)?;
    let RunSnapshot {
        config,
        key,
        model_id,
        generation,
    } = start::snapshot_for_run(
        &state.ai_providers_lock,
        &AppProviderFiles(&app),
        &AppSecrets(&app),
        &state.ai_agent_capabilities,
        &input.provider_id,
        input.model.as_deref(),
    )?;
    let provider = config.clone();
    let prepare_input = PrepareInput {
        config,
        key,
        model_id: model_id.clone(),
        generation,
    };
    // Fixed-wire kinds fail up front as before; Ollama is identified in the run task.
    let preparation = prepare::begin(prepare_input, &state.ai_agent_capabilities)?;
    let mode = super::ai_agent_data::SafetyMode::parse(input.safety_mode.as_deref());
    let mut gate: Box<dyn run::RequestGate + Send> = Box::new(run::OpenGate);
    let mut bound_to = None;
    let mut with_data = false;
    // Tools are bound to one runtime connection, resolved here, never chosen by the model.
    let (tools, dialect) = match input.connection_id.as_deref() {
        Some(id) => {
            let connection_id =
                uuid::Uuid::parse_str(id).map_err(|_| "CONNECTION_NOT_FOUND".to_string())?;
            // Admitted once for the run; every tool is admitted again.
            let connection =
                crate::engines::runtime::admission::admit_runtime(&state, connection_id)?;
            let admission =
                crate::engines::runtime::admission::runtime_admission(&state, connection_id);
            let executor =
                catalog::executor_for(&connection).ok_or_else(|| ENGINE_UNSUPPORTED.to_string())?;
            let dialect = executor.dialect();
            let connections = Arc::clone(&state.connections);
            let alive: catalog::tools::Alive =
                Arc::new(move || connections.contains_key(&connection_id));
            let policy = catalog::tools::MetadataPolicy {
                column_details: input.include_column_details,
            };
            bound_to = Some(connection_id);
            let mut tools = catalog::tools::registry(
                executor.clone(),
                alive.clone(),
                admission.clone(),
                policy,
            );
            let bound = super::ai_agent_data::BoundConnection {
                id: connection_id,
                connection: &connection,
                catalog: executor,
                alive,
                admission,
            };
            if let Some((data_tools, consent_gate)) =
                super::ai_agent_data::data_tools(&app, &state, bound, &provider, mode)
            {
                tools = tools.with(data_tools);
                if input.history_has_data {
                    consent_gate.mark_data_read();
                }
                gate = Box::new(consent_gate);
                with_data = true;
            } else if input.history_has_data {
                gate = Box::new(
                    super::ai_agent_data::history_gate(&app, &state, connection_id, &provider)
                        .ok_or_else(|| DATA_ACCESS_REQUIRED.to_string())?,
                );
            }
            (tools, Some(dialect))
        }
        // Earlier data answers need a connection whose consent can be checked.
        None if input.history_has_data => return Err(DATA_ACCESS_REQUIRED.into()),
        None => (ToolRegistry::default(), None),
    };
    let question = agent::compose_question(
        &input.question,
        &agent::TurnContext {
            history: &input.history,
            editor_sql: input.editor_sql.as_deref(),
            active_schema: input.active_schema.as_deref(),
            active_table: input.active_table.as_deref(),
            target_table: input.target_table.as_deref(),
            reply_language: input.reply_language.as_deref(),
        },
    )?;
    let guard = state.ai_agent_runs.start_on(&input.run_id, bound_to)?;
    let capabilities = Arc::clone(&state.ai_agent_capabilities);
    let probes = Arc::clone(&state.ai_ollama_probes);
    let system = agent::system_prompt(dialect, with_data);
    tauri::async_runtime::spawn(async move {
        let terminal = PlainSink(on_event.clone());
        prepare::drive_turn(
            preparation,
            probes,
            Arc::clone(&capabilities),
            guard,
            run::TURN_DEADLINE,
            &terminal,
            |prepared, remaining, cancel| async move {
                let sink = ChannelSink {
                    channel: on_event,
                    capabilities,
                    capability_key: prepared.capability_key,
                };
                let input = RunInput {
                    model_id: &model_id,
                    system: &system,
                    question: &question,
                    deadline: remaining,
                    tool_timeout: run::TOOL_TIMEOUT,
                    cleanup_grace: run::CLEANUP_GRACE,
                    gate: gate.as_ref(),
                };
                run::run_turn(&prepared.model, &tools, input, &sink, &cancel).await;
            },
        )
        .await;
    });
    Ok(())
}

/// Sends preparation's terminal events; it records nothing in the capability cache.
struct PlainSink(Channel<AgentEvent>);

impl EventSink for PlainSink {
    fn send(&self, event: AgentEvent) -> bool {
        self.0.send(event).is_ok()
    }
}

/// Cancels a run. Safe to call before the run started or after it finished.
#[tauri::command]
pub fn ai_agent_cancel(state: tauri::State<'_, AppState>, run_id: String) {
    state.ai_agent_runs.cancel(&run_id);
}

/// Longest suggested SQL the read-only check looks at; longer text is "unknown".
const MAX_SAFETY_SQL_BYTES: usize = 64 * 1024;

/// Whether SQL the assistant suggested is a single read-only query on this connection,
/// so its preview may offer Run (plan R7). Fails closed: "unknown" unless the syntax is
/// understood and the connection's catalog shows its function calls can only be
/// built-ins (see `CatalogExecutor::only_builtin_code`).
#[tauri::command]
pub async fn ai_agent_sql_safety(
    state: tauri::State<'_, AppState>,
    sql: String,
    connection_id: String,
) -> Result<SqlSafety, String> {
    if sql.len() > MAX_SAFETY_SQL_BYTES {
        return Ok(SqlSafety::Unknown);
    }
    let Some(executor) = uuid::Uuid::parse_str(&connection_id)
        .ok()
        .and_then(|id| crate::engines::runtime::admission::admit_runtime(&state, id).ok())
        .and_then(|connection| catalog::executor_for(&connection))
    else {
        return Ok(SqlSafety::Unknown);
    };
    Ok(safety_on(executor.as_ref(), &sql).await)
}

/// The syntax check, then the connection check, on a short-lived tracked context.
async fn safety_on(executor: &dyn catalog::CatalogExecutor, sql: &str) -> SqlSafety {
    if sql_safety::classify(sql, executor.sql_engine()) != SqlSafety::ReadOnly {
        return SqlSafety::Unknown;
    }
    let ctx = run::ToolContext {
        cancel: tokio_util::sync::CancellationToken::new(),
        tracker: tokio_util::task::TaskTracker::new(),
    };
    let trusted = executor.only_builtin_code(&ctx).await;
    ctx.cancel.cancel();
    ctx.tracker.close();
    ctx.tracker.wait().await;
    match trusted {
        Ok(true) => SqlSafety::ReadOnly,
        _ => SqlSafety::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::catalog::{CatalogExecutor, TableDescription, TableRef};
    use crate::ai::agent::run::ToolContext;
    use async_trait::async_trait;

    struct Catalog(Result<bool, String>);

    #[async_trait]
    impl CatalogExecutor for Catalog {
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
            _: &str,
            _: &str,
            _: &ToolContext,
        ) -> Result<TableDescription, String> {
            Err("no".into())
        }
        async fn only_builtin_code(&self, _: &ToolContext) -> Result<bool, String> {
            self.0.clone()
        }
    }

    #[tokio::test]
    async fn read_only_needs_both_the_syntax_and_the_connection_check() {
        let trusted = Catalog(Ok(true));
        assert_eq!(
            safety_on(&trusted, "SELECT lower(name) FROM t").await,
            SqlSafety::ReadOnly
        );
        assert_eq!(
            safety_on(&trusted, "SELECT pg_advisory_lock(1)").await,
            SqlSafety::Unknown
        );
        // A user overload such as `public.lower(integer)` or a view that runs other
        // code makes the connection check say no.
        assert_eq!(
            safety_on(&Catalog(Ok(false)), "SELECT lower(1)").await,
            SqlSafety::Unknown
        );
        assert_eq!(
            safety_on(&Catalog(Err("catalog query failed".into())), "SELECT 1").await,
            SqlSafety::Unknown
        );
    }
}
