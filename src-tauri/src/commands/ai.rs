use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::{ai_runtime, file_storage, license, security::secrets, state::AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
    Openai,
    Anthropic,
    Gemini,
    Openrouter,
    Grok,
    Groq,
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
    #[serde(default)]
    pub models: Vec<String>,
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
        AiProviderKind::Groq => "https://api.groq.com/openai/v1",
        AiProviderKind::Deepseek => "https://api.deepseek.com/v1",
        AiProviderKind::GithubCopilot => "https://models.inference.ai.azure.com",
        AiProviderKind::Ollama => "http://127.0.0.1:11434/v1",
        AiProviderKind::LocalOpenaiCompatible => "http://127.0.0.1:11434/v1",
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
    config.id = config.id.trim().to_string();
    config.label = config.label.trim().to_string();
    config.default_model = config.default_model.trim().to_string();
    config.models = config
        .models
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .fold(Vec::new(), |mut models, model| {
            if !models.contains(&model) {
                models.push(model);
            }
            models
        });
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
        } else {
            config.base_url = Some(default_base_url(&config.kind).to_string());
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
    if !config.models.contains(&config.default_model) {
        config.models.insert(0, config.default_model.clone());
    }
    Ok(config)
}

fn provider_key_ref(provider_id: &str) -> String {
    format!("politedb:ai:{provider_id}:api_key")
}

fn provider_api_key(
    app: &AppHandle,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    if is_local_provider(&provider.kind) {
        return Ok(None);
    }
    let key_ref = provider
        .api_key_ref
        .as_deref()
        .ok_or_else(|| "AI_PROVIDER_API_KEY_REQUIRED".to_string())?;
    secrets::keychain_get(app, key_ref)
        .map(Some)
        .map_err(|_| "AI_PROVIDER_API_KEY_MISSING".to_string())
}

fn find_provider(app: &AppHandle, provider_id: &str) -> Result<AiProviderConfig, String> {
    load_provider_file(app)?
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| "AI_PROVIDER_NOT_FOUND".to_string())
}

fn first_text_from_openai_like(value: &serde_json::Value) -> String {
    let content = value
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"));

    match content {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str().or_else(|| {
                    part.get("text")
                        .and_then(|text| text.as_str())
                        .or_else(|| part.get("content").and_then(|text| text.as_str()))
                })
            })
            .collect::<Vec<_>>()
            .join("")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

async fn complete_openai_like(
    http: &reqwest::Client,
    provider: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: Option<&str>,
) -> Result<String, String> {
    let base = provider
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(&provider.kind))
        .trim_end_matches('/');
    let model = request.model.as_deref().unwrap_or(&provider.default_model);
    let is_groq_gpt_oss =
        matches!(provider.kind, AiProviderKind::Groq) && model.starts_with("openai/gpt-oss-");
    let url = format!("{base}/chat/completions");
    let mut payload = json!({
        "model": model,
        "messages": request.messages,
        "temperature": request.temperature.unwrap_or(0.2),
        "stream": false
    });
    if is_groq_gpt_oss {
        // GPT-OSS spends completion tokens on hidden reasoning before producing
        // final content. A small budget can return HTTP 200 with empty content.
        payload["max_completion_tokens"] = json!(request.max_tokens.unwrap_or(4096).max(4096));
    } else if let Some(max_tokens) = request.max_tokens {
        payload["max_tokens"] = json!(max_tokens);
    }
    if is_groq_gpt_oss {
        payload["reasoning_effort"] = json!("low");
        payload["include_reasoning"] = json!(false);
    }
    let mut builder = http.post(url).json(&payload);
    if let Some(api_key) = api_key {
        builder = builder.bearer_auth(api_key);
    }
    let res = builder
        .send()
        .await
        .map_err(|e| format!("AI_CHAT_REQUEST_FAILED: {e}"))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| format!("AI_CHAT_RESPONSE_READ_FAILED: {e}"))?;
    if !status.is_success() {
        return Err(format!("AI_CHAT_FAILED: {status} {body}"));
    }
    let value = serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| format!("AI_CHAT_RESPONSE_JSON_FAILED: {e}"))?;
    let text = first_text_from_openai_like(&value);
    if text.is_empty() {
        let finish_reason = value
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(|reason| reason.as_str());
        if finish_reason == Some("length") {
            return Err("AI_CHAT_OUTPUT_TOKEN_LIMIT: model produced no final content".into());
        }
    }
    Ok(text)
}

async fn complete_anthropic(
    http: &reqwest::Client,
    provider: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: &str,
) -> Result<String, String> {
    let base = provider
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(&provider.kind))
        .trim_end_matches('/');
    let system = request
        .messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let messages = request
        .messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| {
            json!({
                "role": if message.role == "assistant" { "assistant" } else { "user" },
                "content": message.content,
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "model": request.model.as_deref().unwrap_or(&provider.default_model),
        "max_tokens": request.max_tokens.unwrap_or(1024),
        "temperature": request.temperature.unwrap_or(0.2),
        "system": system,
        "messages": messages,
    });
    let res = http
        .post(format!("{base}/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("AI_CHAT_REQUEST_FAILED: {e}"))?;
    parse_text_response(res, |value| {
        value
            .get("content")
            .and_then(|content| content.as_array())
            .and_then(|content| {
                content
                    .iter()
                    .find(|item| item.get("type").and_then(|v| v.as_str()) == Some("text"))
            })
            .and_then(|item| item.get("text"))
            .and_then(|text| text.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    })
    .await
}

async fn complete_gemini(
    http: &reqwest::Client,
    provider: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: &str,
) -> Result<String, String> {
    let base = provider
        .base_url
        .as_deref()
        .unwrap_or(default_base_url(&provider.kind))
        .trim_end_matches('/');
    let model = request.model.as_deref().unwrap_or(&provider.default_model);
    let system = request
        .messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let contents = request
        .messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| {
            json!({
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": message.content }],
            })
        })
        .collect::<Vec<_>>();
    let mut payload = json!({
        "contents": contents,
        "generationConfig": {
            "temperature": request.temperature.unwrap_or(0.2),
        }
    });
    if !system.is_empty() {
        payload["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if let Some(max_tokens) = request.max_tokens {
        payload["generationConfig"]["maxOutputTokens"] = json!(max_tokens);
    }
    let res = http
        .post(format!("{base}/models/{model}:generateContent"))
        .header("x-goog-api-key", api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("AI_CHAT_REQUEST_FAILED: {e}"))?;
    parse_text_response(res, |value| {
        value
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(|text| text.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    })
    .await
}

async fn parse_text_response(
    res: reqwest::Response,
    extract: impl FnOnce(&serde_json::Value) -> String,
) -> Result<String, String> {
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| format!("AI_CHAT_RESPONSE_READ_FAILED: {e}"))?;
    if !status.is_success() {
        return Err(format!("AI_CHAT_FAILED: {status} {body}"));
    }
    let value = serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| format!("AI_CHAT_RESPONSE_JSON_FAILED: {e}"))?;
    Ok(extract(&value))
}

async fn complete_with_provider(
    provider: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: Option<&str>,
) -> Result<String, String> {
    let http = reqwest::Client::new();
    match provider.kind {
        AiProviderKind::Anthropic => {
            complete_anthropic(&http, provider, request, api_key.unwrap_or_default()).await
        }
        AiProviderKind::Gemini => {
            complete_gemini(&http, provider, request, api_key.unwrap_or_default()).await
        }
        _ => complete_openai_like(&http, provider, request, api_key).await,
    }
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
pub async fn ai_runtime_delete_default_model(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ai_runtime::AiRuntimeStatus, String> {
    ai_runtime::ai_runtime_delete_default_model(&app, &state).await
}

#[tauri::command]
pub fn ai_provider_list(app: AppHandle) -> Result<Vec<AiProviderConfig>, String> {
    Ok(load_provider_file(&app)?.providers)
}

#[tauri::command]
pub fn ai_provider_save_config(
    app: AppHandle,
    config: AiProviderConfig,
) -> Result<AiProviderConfig, String> {
    let mut file = load_provider_file(&app)?;
    let existing_key_ref = file
        .providers
        .iter()
        .find(|provider| provider.id == config.id)
        .and_then(|provider| provider.api_key_ref.clone());
    let mut config = normalize_provider(config)?;
    if config.api_key_ref.is_none() {
        config.api_key_ref = existing_key_ref;
    }
    if config.is_default == Some(true) {
        for provider in &mut file.providers {
            provider.is_default = Some(false);
        }
    }
    if let Some(index) = file
        .providers
        .iter()
        .position(|provider| provider.id == config.id)
    {
        file.providers[index] = config.clone();
    } else {
        file.providers.push(config.clone());
    }
    save_provider_file(&app, &file)?;
    Ok(config)
}

#[tauri::command]
pub fn ai_provider_set_key(
    app: AppHandle,
    provider_id: String,
    api_key: String,
) -> Result<AiProviderConfig, String> {
    let provider_id = provider_id.trim();
    let api_key = api_key.trim();
    if provider_id.is_empty() {
        return Err("AI_PROVIDER_ID_REQUIRED".into());
    }
    if api_key.is_empty() {
        return Err("AI_PROVIDER_API_KEY_REQUIRED".into());
    }
    let key_ref = provider_key_ref(provider_id);
    secrets::keychain_set(&app, &key_ref, api_key)?;
    let mut file = load_provider_file(&app)?;
    let provider = file
        .providers
        .iter_mut()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| "AI_PROVIDER_NOT_FOUND".to_string())?;
    provider.api_key_ref = Some(key_ref);
    let saved = provider.clone();
    save_provider_file(&app, &file)?;
    Ok(saved)
}

#[tauri::command]
pub async fn ai_provider_validate_config(
    app: AppHandle,
    config: AiProviderConfig,
    api_key: Option<String>,
) -> Result<(), String> {
    let config = normalize_provider(config)?;
    let supplied_key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let stored_key = if !is_local_provider(&config.kind) && supplied_key.is_none() {
        provider_api_key(&app, &config)?
    } else {
        None
    };
    let request = AiChatCompleteRequest {
        provider_id: config.id.clone(),
        model: Some(config.default_model.clone()),
        messages: vec![AiChatMessage {
            role: "user".into(),
            content: "Reply with OK.".into(),
        }],
        temperature: Some(0.0),
        max_tokens: Some(128),
    };
    let text =
        complete_with_provider(&config, &request, supplied_key.or(stored_key.as_deref())).await?;
    if text.is_empty() {
        return Err("AI_PROVIDER_MODEL_INVALID: empty response".into());
    }
    Ok(())
}

#[tauri::command]
pub fn ai_provider_delete(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut file = load_provider_file(&app)?;
    if let Some(key_ref) = file
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .and_then(|provider| provider.api_key_ref.as_deref())
    {
        let _ = secrets::keychain_delete(&app, key_ref);
    }
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
    if !provider.enabled {
        return Err("AI_PROVIDER_DISABLED".into());
    }
    let api_key = provider_api_key(&app, &provider)?;
    let text = complete_with_provider(&provider, &request, api_key.as_deref()).await?;
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
