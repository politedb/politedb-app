use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::{ai_runtime, file_storage, license, state::AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
    Openai,
    Anthropic,
    Gemini,
    Openrouter,
    Grok,
    Deepseek,
    GithubCopilot,
    Ollama,
    LocalOpenaiCompatible,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub kind: AiProviderKind,
    pub label: String,
    pub base_url: Option<String>,
    pub host: Option<String>,
    pub sub_path: Option<String>,
    pub default_model: String,
    pub api_key_ref: Option<String>,
    pub enabled: bool,
    pub is_default: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiProviderFile {
    providers: Vec<AiProviderConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatCompleteRequest {
    pub provider_id: String,
    pub model: Option<String>,
    pub messages: Vec<AiChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

fn default_base_url(kind: &AiProviderKind) -> &'static str {
    match kind {
        AiProviderKind::Ollama => "http://127.0.0.1:11434/v1",
        AiProviderKind::LocalOpenaiCompatible => "http://127.0.0.1:11434/v1",
        _ => "",
    }
}

fn is_local_provider(kind: &AiProviderKind) -> bool {
    matches!(
        kind,
        AiProviderKind::Ollama | AiProviderKind::LocalOpenaiCompatible
    )
}

fn load_provider_file(app: &AppHandle) -> Result<AiProviderFile, String> {
    let path = file_storage::path_ai_providers(app)?;
    Ok(file_storage::json_read_if_exists::<AiProviderFile>(&path)?.unwrap_or_default())
}

fn save_provider_file(app: &AppHandle, file: &AiProviderFile) -> Result<(), String> {
    let path = file_storage::path_ai_providers(app)?;
    file_storage::json_write_atomic(&path, file)
}

fn normalize_provider(mut config: AiProviderConfig) -> Result<AiProviderConfig, String> {
    if !is_local_provider(&config.kind) {
        return Err("AI_ONLY_LOCAL_PROVIDER_SUPPORTED".into());
    }
    config.id = config.id.trim().to_string();
    config.label = config.label.trim().to_string();
    config.default_model = config.default_model.trim().to_string();
    config.host = config
        .host
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());
    config.sub_path = config
        .sub_path
        .map(|v| {
            let trimmed = v.trim().trim_end_matches('/').to_string();
            if trimmed.is_empty() || trimmed.starts_with('/') {
                trimmed
            } else {
                format!("/{trimmed}")
            }
        })
        .filter(|v| !v.is_empty());
    config.base_url = config
        .base_url
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());
    if config.base_url.is_none() {
        if let Some(host) = config.host.as_deref() {
            let sub_path = config.sub_path.as_deref().unwrap_or("");
            config.base_url = Some(
                format!("{host}{sub_path}")
                    .trim_end_matches('/')
                    .to_string(),
            );
        }
    }
    if config.id.is_empty() {
        return Err("AI_PROVIDER_ID_REQUIRED".into());
    }
    if config.label.is_empty() {
        return Err("AI_PROVIDER_LABEL_REQUIRED".into());
    }
    if config.default_model.is_empty() {
        return Err("AI_PROVIDER_MODEL_REQUIRED".into());
    }
    Ok(config)
}

fn find_provider(app: &AppHandle, provider_id: &str) -> Result<AiProviderConfig, String> {
    load_provider_file(app)?
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| "AI_PROVIDER_NOT_FOUND".to_string())
}

fn first_text_from_openai_like(value: serde_json::Value) -> String {
    value
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

async fn complete_openai_like(
    http: &reqwest::Client,
    provider: &AiProviderConfig,
    request: &AiChatCompleteRequest,
) -> Result<String, String> {
    let base = provider
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(&provider.kind))
        .trim_end_matches('/');
    let model = request.model.as_deref().unwrap_or(&provider.default_model);
    let url = format!("{base}/chat/completions");
    let res = http
        .post(url)
        .json(&json!({
            "model": model,
            "messages": request.messages,
            "temperature": request.temperature.unwrap_or(0.2),
            "max_tokens": request.max_tokens.unwrap_or(512),
            "stream": false
        }))
        .send()
        .await
        .map_err(|e| format!("AI_CHAT_REQUEST_FAILED: {e}"))?;
    let status = res.status();
    let value = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("AI_CHAT_RESPONSE_JSON_FAILED: {e}"))?;
    if !status.is_success() {
        return Err(format!("AI_CHAT_FAILED: {status} {value}"));
    }
    Ok(first_text_from_openai_like(value))
}

#[tauri::command]
pub async fn ai_runtime_status(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ai_runtime::AiRuntimeStatus, String> {
    Ok(ai_runtime::ai_runtime_status(&app, &state).await)
}

#[tauri::command]
pub async fn ai_runtime_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ai_runtime::AiRuntimeStatus, String> {
    ai_runtime::ai_runtime_start(&app, &state).await
}

#[tauri::command]
pub async fn ai_runtime_stop(
    state: tauri::State<'_, AppState>,
) -> Result<ai_runtime::AiRuntimeStatus, String> {
    ai_runtime::ai_runtime_stop(&state).await
}

#[tauri::command]
pub async fn ai_runtime_download_default_model(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ai_runtime::AiRuntimeStatus, String> {
    ai_runtime::ai_runtime_download_default_model(&app, &state).await
}

#[tauri::command]
pub async fn ai_runtime_cancel_model_download(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ai_runtime::AiRuntimeStatus, String> {
    Ok(ai_runtime::ai_runtime_cancel_model_download(&app, &state).await)
}

#[tauri::command]
pub fn ai_provider_list(app: AppHandle) -> Result<Vec<AiProviderConfig>, String> {
    Ok(load_provider_file(&app)?
        .providers
        .into_iter()
        .filter(|provider| provider.id == "local" && is_local_provider(&provider.kind))
        .collect())
}

#[tauri::command]
pub fn ai_provider_save_config(
    app: AppHandle,
    config: AiProviderConfig,
) -> Result<AiProviderConfig, String> {
    let config = normalize_provider(config)?;
    let mut file = load_provider_file(&app)?;
    file.providers.clear();
    file.providers.push(config.clone());
    save_provider_file(&app, &file)?;
    Ok(config)
}

#[tauri::command]
pub fn ai_provider_delete(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut file = load_provider_file(&app)?;
    file.providers.retain(|p| p.id != provider_id);
    save_provider_file(&app, &file)
}

#[tauri::command]
pub async fn ai_chat_complete(
    app: AppHandle,
    request: AiChatCompleteRequest,
) -> Result<String, String> {
    let license_state = license::license_state_load(&app)?;
    if license::blocks_ai_feature(&license_state) {
        return Err("AI_LICENSE_REQUIRED".into());
    }
    let provider = find_provider(&app, &request.provider_id)?;
    if !is_local_provider(&provider.kind) {
        return Err("AI_ONLY_LOCAL_PROVIDER_SUPPORTED".into());
    }
    if !provider.enabled {
        return Err("AI_PROVIDER_DISABLED".into());
    }
    let http = reqwest::Client::new();
    let text = complete_openai_like(&http, &provider, &request).await?;
    if text.is_empty() {
        return Err("AI_CHAT_EMPTY_RESPONSE".into());
    }
    Ok(text)
}

#[tauri::command]
pub async fn ai_provider_test(app: AppHandle, provider_id: String) -> Result<String, String> {
    ai_chat_complete(
        app,
        AiChatCompleteRequest {
            provider_id,
            model: None,
            messages: vec![AiChatMessage {
                role: "user".into(),
                content: "Reply with OK.".into(),
            }],
            temperature: Some(0.0),
            max_tokens: Some(16),
        },
    )
    .await
}
