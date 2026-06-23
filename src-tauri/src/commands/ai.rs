use tauri::AppHandle;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ai_runtime, file_storage, security::secrets, state::AppState};

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
        AiProviderKind::Openai => "https://api.openai.com/v1",
        AiProviderKind::Anthropic => "https://api.anthropic.com/v1",
        AiProviderKind::Gemini => "https://generativelanguage.googleapis.com/v1beta",
        AiProviderKind::Openrouter => "https://openrouter.ai/api/v1",
        AiProviderKind::Grok => "https://api.x.ai/v1",
        AiProviderKind::Deepseek => "https://api.deepseek.com",
        AiProviderKind::GithubCopilot => "https://api.githubcopilot.com/v1",
        AiProviderKind::Ollama => "http://127.0.0.1:11434/v1",
        AiProviderKind::LocalOpenaiCompatible => "http://127.0.0.1:11434/v1",
    }
}

fn provider_key(provider_id: &str) -> String {
    format!("politedb:ai:{provider_id}:api_key")
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
            config.base_url = Some(format!("{host}{sub_path}").trim_end_matches('/').to_string());
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
    if config.api_key_ref.is_none()
        && !matches!(config.kind, AiProviderKind::LocalOpenaiCompatible | AiProviderKind::Ollama)
    {
        config.api_key_ref = Some(provider_key(&config.id));
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

fn api_key_for(app: &AppHandle, provider: &AiProviderConfig) -> Result<Option<String>, String> {
    if matches!(provider.kind, AiProviderKind::LocalOpenaiCompatible | AiProviderKind::Ollama) {
        return Ok(None);
    }
    let key = provider
        .api_key_ref
        .as_deref()
        .unwrap_or("")
        .trim();
    if key.is_empty() {
        return Err("AI_PROVIDER_API_KEY_REF_MISSING".into());
    }
    secrets::keychain_get(app, key).map(Some)
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
    api_key: Option<String>,
    request: &AiChatCompleteRequest,
) -> Result<String, String> {
    let base = provider
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(&provider.kind))
        .trim_end_matches('/');
    let model = request.model.as_deref().unwrap_or(&provider.default_model);
    let url = format!("{base}/chat/completions");
    let mut builder = http.post(url).json(&json!({
        "model": model,
        "messages": request.messages,
        "temperature": request.temperature.unwrap_or(0.2),
        "max_tokens": request.max_tokens.unwrap_or(512),
        "stream": false
    }));
    if let Some(key) = api_key {
        builder = builder.bearer_auth(key);
    }
    let res = builder
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

async fn complete_anthropic(
    http: &reqwest::Client,
    provider: &AiProviderConfig,
    api_key: String,
    request: &AiChatCompleteRequest,
) -> Result<String, String> {
    let base = provider
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(&provider.kind))
        .trim_end_matches('/');
    let model = request.model.as_deref().unwrap_or(&provider.default_model);
    let messages: Vec<_> = request
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| json!({ "role": if m.role == "assistant" { "assistant" } else { "user" }, "content": m.content }))
        .collect();
    let res = http
        .post(format!("{base}/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": model,
            "messages": messages,
            "max_tokens": request.max_tokens.unwrap_or(512),
            "temperature": request.temperature.unwrap_or(0.2)
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
    Ok(value
        .get("content")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn complete_gemini(
    http: &reqwest::Client,
    provider: &AiProviderConfig,
    api_key: String,
    request: &AiChatCompleteRequest,
) -> Result<String, String> {
    let base = provider
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(&provider.kind))
        .trim_end_matches('/');
    let model = request.model.as_deref().unwrap_or(&provider.default_model);
    let contents: Vec<_> = request
        .messages
        .iter()
        .map(|m| json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{ "text": m.content }]
        }))
        .collect();
    let res = http
        .post(format!("{base}/models/{model}:generateContent?key={api_key}"))
        .json(&json!({
            "contents": contents,
            "generationConfig": {
                "temperature": request.temperature.unwrap_or(0.2),
                "maxOutputTokens": request.max_tokens.unwrap_or(512)
            }
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
    Ok(value
        .get("candidates")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.get("parts"))
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
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
    Ok(load_provider_file(&app)?.providers)
}

#[tauri::command]
pub fn ai_provider_save_config(app: AppHandle, config: AiProviderConfig) -> Result<AiProviderConfig, String> {
    let config = normalize_provider(config)?;
    let mut file = load_provider_file(&app)?;
    file.providers.retain(|p| p.id != config.id);
    file.providers.push(config.clone());
    save_provider_file(&app, &file)?;
    Ok(config)
}

#[tauri::command]
pub fn ai_provider_delete(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut file = load_provider_file(&app)?;
    file.providers.retain(|p| p.id != provider_id);
    let _ = secrets::keychain_delete(&app, &provider_key(&provider_id));
    save_provider_file(&app, &file)
}

#[tauri::command]
pub fn ai_provider_set_key(app: AppHandle, provider_id: String, api_key: String) -> Result<String, String> {
    let key = provider_key(provider_id.trim());
    secrets::keychain_set(&app, &key, api_key.trim())?;
    Ok(key)
}

#[tauri::command]
pub async fn ai_chat_complete(app: AppHandle, request: AiChatCompleteRequest) -> Result<String, String> {
    let provider = find_provider(&app, &request.provider_id)?;
    if !provider.enabled {
        return Err("AI_PROVIDER_DISABLED".into());
    }
    let api_key = api_key_for(&app, &provider)?;
    let http = reqwest::Client::new();
    let text = match provider.kind {
        AiProviderKind::Anthropic => {
            complete_anthropic(&http, &provider, api_key.ok_or("AI_PROVIDER_API_KEY_MISSING")?, &request).await?
        }
        AiProviderKind::Gemini => {
            complete_gemini(&http, &provider, api_key.ok_or("AI_PROVIDER_API_KEY_MISSING")?, &request).await?
        }
        AiProviderKind::Openai
        | AiProviderKind::Openrouter
        | AiProviderKind::Grok
        | AiProviderKind::Deepseek
        | AiProviderKind::GithubCopilot
        | AiProviderKind::Ollama
        | AiProviderKind::LocalOpenaiCompatible => {
            complete_openai_like(&http, &provider, api_key, &request).await?
        }
    };
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
