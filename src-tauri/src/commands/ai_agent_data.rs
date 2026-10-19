//! Data tools wiring and data-access consent commands for the AI agent (plan
//! ai-agent R4/R5). The coordinator, tools and consent rules live in
//! `crate::ai::agent`; this file binds them to app state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

use crate::ai::adapters::{native_approval, AppConsentFiles, AppProviderFiles};
use crate::ai::agent::catalog::{self, CatalogExecutor};
use crate::ai::agent::consent::{self, ProfileBinding, DATA_ACCESS_REQUIRED};
use crate::ai::agent::data::{self, tools::DataAccess};
use crate::ai::agent::run::{AgentTool, RequestGate};
use crate::ai::provider::AiProviderConfig;
use crate::ai::provider_store::ProviderFilePort;
use crate::engines::EngineConnection;
use crate::profiles::store as profile_store;
use crate::state::AppState;

/// The editor's query safety mode, sent when a run starts. Anything unknown counts as
/// `Lock` (no data tools).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyMode {
    Default,
    Safe,
    Production,
    Lock,
}

impl SafetyMode {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("default") => Self::Default,
            Some("safe") => Self::Safe,
            Some("production") => Self::Production,
            _ => Self::Lock,
        }
    }
}

/// Whether `config` may see data from the connection bound by `binding` right now:
/// the saved profile must still describe the target the connection opened (else an
/// edit could point consent at a different database than the one queried), and the
/// grant must match it.
fn bound_consent(
    app: &AppHandle,
    lock: &std::sync::Mutex<()>,
    binding: &ProfileBinding,
    config: &AiProviderConfig,
) -> bool {
    let Ok(profile) = profile_store::profile_get(app, binding.profile_id) else {
        return false;
    };
    if !binding.matches(&profile) {
        return false;
    }
    let _lock = lock.lock().unwrap_or_else(|e| e.into_inner());
    consent::is_granted(&AppConsentFiles(app), &profile, config)
}

/// Stops a run before any provider request once data it read has lost its consent.
pub struct ConsentGate {
    provenance: Arc<AtomicBool>,
    consent: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl ConsentGate {
    /// The transcript already holds data from this connection (earlier answers in the
    /// history): check consent before the very first request.
    pub fn mark_data_read(&self) {
        self.provenance.store(true, Ordering::SeqCst);
    }
}

/// A gate for a run whose history holds data from `connection_id` but that reads no
/// new data (no data tools offered). `None` when the connection has no saved profile.
pub fn history_gate(
    app: &AppHandle,
    state: &AppState,
    connection_id: Uuid,
    config: &AiProviderConfig,
) -> Option<ConsentGate> {
    let binding = state.connection_profiles.get(&connection_id)?.clone();
    let (app, config) = (app.clone(), config.clone());
    let lock = Arc::clone(&state.ai_consent_lock);
    Some(ConsentGate {
        provenance: Arc::new(AtomicBool::new(true)),
        consent: Arc::new(move || bound_consent(&app, &lock, &binding, &config)),
    })
}

impl RequestGate for ConsentGate {
    fn check(&self) -> Result<(), String> {
        if self.provenance.load(Ordering::SeqCst) && !(self.consent)() {
            Err(DATA_ACCESS_REQUIRED.into())
        } else {
            Ok(())
        }
    }
}

/// The runtime connection a run is bound to, and its catalog access.
pub struct BoundConnection<'a> {
    pub id: Uuid,
    pub connection: &'a EngineConnection,
    pub catalog: Arc<dyn CatalogExecutor>,
    pub alive: catalog::tools::Alive,
}

/// Data tools for a run on `bound`, with the gate that guards the transcript, or
/// `None` when they are unavailable: other engines, no saved profile behind the
/// connection, lock mode, or safe/production without native approval.
pub fn data_tools(
    app: &AppHandle,
    state: &AppState,
    bound: BoundConnection<'_>,
    config: &AiProviderConfig,
    mode: SafetyMode,
) -> Option<(Vec<Arc<dyn AgentTool>>, ConsentGate)> {
    let BoundConnection {
        id: connection_id,
        connection,
        catalog,
        alive,
    } = bound;
    let executor = data::executor_for(connection)?;
    let binding = state.connection_profiles.get(&connection_id)?.clone();
    let approval = match mode {
        SafetyMode::Lock => return None,
        SafetyMode::Default => None,
        SafetyMode::Safe | SafetyMode::Production => Some(native_approval()?),
    };
    let label = profile_store::profile_get(app, binding.profile_id)
        .map(|p| p.label)
        .unwrap_or_else(|_| "this connection".into());
    let consent: Arc<dyn Fn() -> bool + Send + Sync> = {
        let (app, config) = (app.clone(), config.clone());
        let lock = Arc::clone(&state.ai_consent_lock);
        Arc::new(move || bound_consent(&app, &lock, &binding, &config))
    };
    let provenance = Arc::new(AtomicBool::new(false));
    let access = Arc::new(DataAccess {
        executor,
        catalog,
        alive,
        consent: consent.clone(),
        approval,
        label,
        provenance: provenance.clone(),
    });
    Some((
        data::tools::tools(access),
        ConsentGate {
            provenance,
            consent,
        },
    ))
}

fn provider_config(
    app: &AppHandle,
    state: &AppState,
    provider_id: &str,
) -> Result<AiProviderConfig, String> {
    let _lock = state
        .ai_providers_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    AppProviderFiles(app)
        .load()?
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| "AI_PROVIDER_NOT_FOUND".to_string())
}

/// The saved profile behind a runtime connection that supports data tools.
fn data_profile(state: &AppState, connection_id: &str) -> Option<ProfileBinding> {
    let id = Uuid::parse_str(connection_id).ok()?;
    let connection = state.connections.get(&id)?.clone();
    data::executor_for(&connection)?;
    state.connection_profiles.get(&id).map(|b| b.clone())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataAccessStatus {
    /// Data tools exist for this connection (engine, saved profile, file database).
    pub available: bool,
    pub granted: bool,
    pub label: Option<String>,
}

#[tauri::command]
pub fn ai_agent_data_access_status(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    provider_id: String,
) -> Result<DataAccessStatus, String> {
    let Some(binding) = data_profile(&state, &connection_id) else {
        return Ok(DataAccessStatus {
            available: false,
            granted: false,
            label: None,
        });
    };
    let label = profile_store::profile_get(&app, binding.profile_id)
        .ok()
        .map(|p| p.label);
    let config = provider_config(&app, &state, &provider_id)?;
    Ok(DataAccessStatus {
        available: true,
        granted: bound_consent(&app, &state.ai_consent_lock, &binding, &config),
        label,
    })
}

/// Records the user's "Allow" for this connection's profile and this provider.
#[tauri::command]
pub fn ai_agent_data_access_grant(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    provider_id: String,
) -> Result<(), String> {
    let binding = data_profile(&state, &connection_id)
        .ok_or_else(|| "AI_DATA_ACCESS_UNAVAILABLE".to_string())?;
    let profile = profile_store::profile_get(&app, binding.profile_id)
        .map_err(|_| "AI_DATA_ACCESS_UNAVAILABLE".to_string())?;
    // The profile was edited since connecting: consent would describe another target.
    if !binding.matches(&profile) {
        return Err("AI_DATA_ACCESS_RECONNECT".into());
    }
    let config = provider_config(&app, &state, &provider_id)?;
    let _lock = state
        .ai_consent_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    consent::grant(
        &AppConsentFiles(&app),
        &profile,
        &config,
        chrono::Utc::now().timestamp(),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataAccessGrant {
    pub profile_id: Uuid,
    pub profile_label: Option<String>,
    pub provider_label: Option<String>,
    pub endpoint_host: String,
    pub granted_at: i64,
}

#[tauri::command]
pub fn ai_agent_data_access_list(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DataAccessGrant>, String> {
    let grants = {
        let _lock = state
            .ai_consent_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        consent::list(&AppConsentFiles(&app))
    };
    let providers = {
        let _lock = state
            .ai_providers_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        AppProviderFiles(&app)
            .load()
            .map(|f| f.providers)
            .unwrap_or_default()
    };
    Ok(grants
        .into_iter()
        .map(|g| DataAccessGrant {
            profile_id: g.profile_id,
            profile_label: profile_store::profile_get(&app, g.profile_id)
                .ok()
                .map(|p| p.label),
            provider_label: providers
                .iter()
                .find(|p| p.id == g.provider_id)
                .map(|p| p.label.clone()),
            endpoint_host: g.endpoint_host,
            granted_at: g.granted_at,
        })
        .collect())
}

/// Cancels agent runs on connections opened from `profile_id` (its target or consent
/// may have changed; plan R5).
pub fn cancel_profile_runs(state: &AppState, profile_id: Uuid) {
    let connections: Vec<Uuid> = state
        .connection_profiles
        .iter()
        .filter(|entry| entry.value().profile_id == profile_id)
        .map(|entry| *entry.key())
        .collect();
    state.ai_agent_runs.cancel_on_connections(&connections);
}

/// Revokes every grant for a profile and cancels agent runs reading its connections.
/// The frontend then removes that profile's chat history (plan R6).
#[tauri::command]
pub fn ai_agent_data_access_revoke(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    profile_id: Uuid,
) -> Result<(), String> {
    {
        let _lock = state
            .ai_consent_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        consent::revoke_profile(&AppConsentFiles(&app), profile_id)?;
    }
    cancel_profile_runs(&state, profile_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_or_missing_modes_are_locked() {
        assert_eq!(SafetyMode::parse(Some("default")), SafetyMode::Default);
        assert_eq!(SafetyMode::parse(Some("safe")), SafetyMode::Safe);
        assert_eq!(
            SafetyMode::parse(Some("production")),
            SafetyMode::Production
        );
        for value in [None, Some("lock"), Some(""), Some("DEFAULT"), Some("prod")] {
            assert_eq!(SafetyMode::parse(value), SafetyMode::Lock, "{value:?}");
        }
    }

    #[test]
    fn the_gate_only_closes_after_data_was_read() {
        let provenance = Arc::new(AtomicBool::new(false));
        let gate = ConsentGate {
            provenance: provenance.clone(),
            consent: Arc::new(|| false),
        };
        assert!(gate.check().is_ok());
        provenance.store(true, Ordering::SeqCst);
        assert_eq!(gate.check().unwrap_err(), DATA_ACCESS_REQUIRED);
        let open = ConsentGate {
            provenance,
            consent: Arc::new(|| true),
        };
        assert!(open.check().is_ok());
        // Earlier answers in the history hold data: checked before the first request.
        let history = ConsentGate {
            provenance: Arc::new(AtomicBool::new(false)),
            consent: Arc::new(|| false),
        };
        history.mark_data_read();
        assert_eq!(history.check().unwrap_err(), DATA_ACCESS_REQUIRED);
    }
}
