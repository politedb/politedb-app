//! Thin commands for the AI agent; the coordinator lives in `crate::ai::agent`.

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::ai::adapters::{AppProviderFiles, AppSecrets};
use crate::ai::agent::model::{CapabilityCache, CapabilityKey, HttpModel, TOOLS_UNSUPPORTED};
use crate::ai::agent::run::{self, AgentEvent, EventSink, RunInput, ToolRegistry};
use crate::ai::agent::start::{self, RunSnapshot};
use crate::ai::agent::SYSTEM_PROMPT;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartInput {
    /// Client-generated id used to cancel the run.
    pub run_id: String,
    pub provider_id: String,
    pub model: Option<String>,
    pub question: String,
}

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
    let RunSnapshot {
        config,
        key,
        model_id,
        capability_key,
    } = start::snapshot_for_run(
        &state.ai_providers_lock,
        &AppProviderFiles(&app),
        &AppSecrets(&app),
        &state.ai_agent_capabilities,
        &input.provider_id,
        input.model.as_deref(),
    )?;
    if state.ai_agent_capabilities.get(&capability_key) == Some(false) {
        return Err(TOOLS_UNSUPPORTED.into());
    }
    let model = HttpModel::new(config, key)?;
    let guard = state.ai_agent_runs.start(&input.run_id)?;
    let sink = ChannelSink {
        channel: on_event,
        capabilities: Arc::clone(&state.ai_agent_capabilities),
        capability_key,
    };
    let question = input.question;
    tauri::async_runtime::spawn(async move {
        let input = RunInput {
            model_id: &model_id,
            system: SYSTEM_PROMPT,
            question: &question,
            deadline: run::TURN_DEADLINE,
            tool_timeout: run::TOOL_TIMEOUT,
        };
        // Phase 1 registers no tools (plan R7).
        run::run_turn(
            &model,
            &ToolRegistry::default(),
            input,
            &sink,
            &guard.cancel,
        )
        .await;
        drop(guard);
    });
    Ok(())
}

/// Cancels a run. Safe to call before the run started or after it finished.
#[tauri::command]
pub fn ai_agent_cancel(state: tauri::State<'_, AppState>, run_id: String) {
    state.ai_agent_runs.cancel(&run_id);
}
