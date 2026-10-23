//! Thin Tauri commands for AI providers. Policy, storage and transport live in `crate::ai`.

use serde::Deserialize;
use tauri::AppHandle;

use crate::ai::adapters::{AppProviderFiles, AppSecrets};
use crate::ai::chat::{self, AiChatCompleteRequest};
use crate::ai::legacy_model::{self, LegacyModelInfo};
use crate::ai::provider::{self, AiProviderConfig};
use crate::ai::provider_store::{self, KeyChange};
use crate::state::AppState;

/// Key edit sent with a save: blank input keeps the stored key.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum KeyChangeInput {
    Keep,
    Set { value: String },
    Remove,
}

impl From<KeyChangeInput> for KeyChange {
    fn from(input: KeyChangeInput) -> Self {
        match input {
            KeyChangeInput::Keep => KeyChange::Keep,
            KeyChangeInput::Set { value } => KeyChange::Set(value),
            KeyChangeInput::Remove => KeyChange::Remove,
        }
    }
}

fn lock_providers(state: &AppState) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    state
        .ai_providers_lock
        .lock()
        .map_err(|_| "AI_PROVIDER_LOCK_FAILED".to_string())
}

/// Lists providers under the lock so a save in progress (config written, key pending,
/// possibly rolled back) is never observed (plan R13).
#[tauri::command]
pub fn ai_provider_list(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AiProviderConfig>, String> {
    use crate::ai::provider_store::ProviderFilePort;
    let _guard = lock_providers(&state)?;
    Ok(AppProviderFiles(&app).load()?.providers)
}

/// Saves config and key change as one transaction (plan R13). No network I/O.
#[tauri::command]
pub fn ai_provider_save(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: AiProviderConfig,
    key_change: KeyChangeInput,
) -> Result<AiProviderConfig, String> {
    let _guard = lock_providers(&state)?;
    // A changed config (URL, model, key, context size) may change what the model can
    // do. The store trims the id: forget both spellings so no stale entry survives.
    let raw_id = config.id.clone();
    state.forget_ai_provider(&raw_id);
    let saved = provider_store::save(
        &AppProviderFiles(&app),
        &AppSecrets(&app),
        config,
        key_change.into(),
    )?;
    if saved.id != raw_id {
        state.forget_ai_provider(&saved.id);
    }
    Ok(saved)
}

#[tauri::command]
pub fn ai_provider_delete(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    let _guard = lock_providers(&state)?;
    state.forget_ai_provider(&provider_id);
    if provider_id.trim() != provider_id {
        state.forget_ai_provider(provider_id.trim());
    }
    provider_store::delete(&AppProviderFiles(&app), &AppSecrets(&app), &provider_id)
}

/// Resolves the key for a draft request under the provider lock (plan R1/R13), so it is
/// never read mid-save; the network call happens after the lock is released.
fn draft_key(
    app: &AppHandle,
    state: &AppState,
    config: &AiProviderConfig,
    auth: KeyChangeInput,
) -> Result<Option<String>, String> {
    let _guard = lock_providers(state)?;
    provider_store::request_key(&AppSecrets(app), config, &auth.into())
}

/// Lists model ids for an unsaved draft. Metadata only (plan D15);
/// runs regardless of `enabled` because the user asked for it explicitly (plan R3).
/// `request_id` scopes cancellation to the caller (see [`ai_provider_cancel_list_models`]).
#[tauri::command]
pub async fn ai_provider_list_models(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: AiProviderConfig,
    auth: KeyChangeInput,
    request_id: String,
) -> Result<Vec<String>, String> {
    // Registered before any waiting so a cancel sent meanwhile is never lost.
    crate::ai::cancel::run_cancellable(
        &state.ai_discovery_cancel,
        &request_id,
        "AI_PROVIDER_MODELS_CANCELED",
        async {
            let config = provider::validate_for_discovery(config)?;
            let key = draft_key(&app, &state, &config, auth)?;
            chat::list_models(&config, key.as_deref()).await
        },
    )
    .await
}

/// Cancels a model discovery or an Ollama status request by its request id.
#[tauri::command]
pub fn ai_provider_cancel_list_models(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    state.ai_discovery_cancel.cancel(&request_id);
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatusResponse {
    pub request_id: String,
    #[serde(flatten)]
    pub status: crate::ai::ollama::ServerStatus,
}

/// The settings notice for an Ollama provider draft (plan ollama-native-context A10).
/// Persists nothing. Non-Ollama kinds answer without network I/O. Cancel with
/// [`ai_provider_cancel_list_models`] and the same `request_id`.
#[tauri::command]
pub async fn ai_ollama_status(
    state: tauri::State<'_, AppState>,
    config: AiProviderConfig,
    request_id: String,
) -> Result<OllamaStatusResponse, String> {
    let status = crate::ai::cancel::run_cancellable(
        &state.ai_discovery_cancel,
        &request_id,
        "AI_PROVIDER_STATUS_CANCELED",
        async {
            let config = provider::validate_for_discovery(config)?;
            Ok(crate::ai::ollama::server_status(&config).await)
        },
    )
    .await?;
    Ok(OllamaStatusResponse { request_id, status })
}

/// How long the settings Test waits for the provider (chat requests allow
/// minutes; a test that hangs that long would lock the dialog).
const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Tests an unsaved draft with a short completion. Persists nothing and ignores
/// `enabled` (plan R3). AI is free: no license check (D16). Ends after
/// [`TEST_TIMEOUT`], or when [`ai_provider_cancel_list_models`] cancels
/// `request_id`.
#[tauri::command]
pub async fn ai_provider_test_draft(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: AiProviderConfig,
    auth: KeyChangeInput,
    request_id: String,
) -> Result<(), String> {
    let config = provider::validate_for_completion(config)?;
    let key = draft_key(&app, &state, &config, auth)?;
    crate::ai::cancel::run_cancellable(
        &state.ai_discovery_cancel,
        &request_id,
        "AI_PROVIDER_TEST_CANCELED",
        async {
            let request = chat::probe_request(&config);
            probe_within(
                TEST_TIMEOUT,
                chat::complete(&config, &request, key.as_deref()),
            )
            .await
        },
    )
    .await
}

/// The test verdict: the reply must be non-empty and arrive within `limit`.
async fn probe_within(
    limit: std::time::Duration,
    reply: impl std::future::Future<Output = Result<String, String>>,
) -> Result<(), String> {
    let text = tokio::time::timeout(limit, reply)
        .await
        .map_err(|_| "AI_PROVIDER_TEST_TIMEOUT".to_string())??;
    if text.is_empty() {
        return Err("AI_PROVIDER_MODEL_INVALID: empty response".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_chat_complete(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: AiChatCompleteRequest,
) -> Result<String, String> {
    // Config and key are read together under the lock, then the lock is released
    // before any network I/O (plan R1/R13).
    let (config, key) = {
        let _guard = lock_providers(&state)?;
        provider_store::snapshot_for_chat(
            &AppProviderFiles(&app),
            &AppSecrets(&app),
            &request.provider_id,
        )?
    };
    let has_model = request
        .model
        .as_deref()
        .is_some_and(|model| !model.trim().is_empty())
        || !config.default_model.is_empty();
    if !has_model {
        return Err("AI_PROVIDER_MODEL_REQUIRED".into());
    }
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut slot = state.ai_chat_cancel.lock().await;
        if let Some(previous) = slot.replace(cancel_tx) {
            let _ = previous.send(());
        }
    }
    let text = tokio::select! {
        _ = cancel_rx => return Err("AI_CHAT_CANCELED".into()),
        result = chat::complete(&config, &request, key.as_deref()) => result?,
    };
    if text.is_empty() {
        return Err("AI_CHAT_EMPTY_RESPONSE".into());
    }
    Ok(text)
}

fn app_data_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|_| legacy_model::IO_FAILED.to_string())
}

/// Fixed files left by the removed bundled runtime (plan D10).
#[tauri::command]
pub fn ai_legacy_model_info(app: AppHandle) -> Result<LegacyModelInfo, String> {
    legacy_model::info(&app_data_root(&app)?)
}

/// Deletes those files after the user confirmed; returns what remains.
#[tauri::command]
pub fn ai_legacy_model_delete(app: AppHandle) -> Result<LegacyModelInfo, String> {
    legacy_model::delete(&app_data_root(&app)?)
}

#[tauri::command]
pub async fn ai_chat_cancel(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.ai_chat_cancel.lock().await;
    if let Some(tx) = slot.take() {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_key_change_input() {
        let keep: KeyChangeInput = serde_json::from_str(r#"{"action":"keep"}"#).unwrap();
        assert!(matches!(KeyChange::from(keep), KeyChange::Keep));
        let set: KeyChangeInput =
            serde_json::from_str(r#"{"action":"set","value":"tok"}"#).unwrap();
        assert_eq!(KeyChange::from(set), KeyChange::Set("tok".into()));
        let remove: KeyChangeInput = serde_json::from_str(r#"{"action":"remove"}"#).unwrap();
        assert_eq!(KeyChange::from(remove), KeyChange::Remove);
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn a_slow_provider_times_out() {
        let slow = async {
            tokio::time::sleep(Duration::from_secs(120)).await;
            Ok("OK".to_string())
        };
        assert_eq!(
            probe_within(TEST_TIMEOUT, slow).await.unwrap_err(),
            "AI_PROVIDER_TEST_TIMEOUT"
        );
    }

    async fn reply(result: Result<&'static str, &'static str>) -> Result<String, String> {
        result.map(str::to_string).map_err(str::to_string)
    }

    #[tokio::test]
    async fn verdicts() {
        assert!(probe_within(TEST_TIMEOUT, reply(Ok("OK"))).await.is_ok());
        assert_eq!(
            probe_within(TEST_TIMEOUT, reply(Ok(""))).await.unwrap_err(),
            "AI_PROVIDER_MODEL_INVALID: empty response"
        );
        assert_eq!(
            probe_within(TEST_TIMEOUT, reply(Err("AI_CHAT_FAILED: 401 Unauthorized")))
                .await
                .unwrap_err(),
            "AI_CHAT_FAILED: 401 Unauthorized"
        );
    }
}
