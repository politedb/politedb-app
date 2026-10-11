//! Requests to AI providers: chat completion and model discovery (plan R1, R10).
//!
//! Every request URL is re-validated against the URL policy and sent through
//! [`transport::client_for`]; errors carry codes only (no URLs, hosts, prompts or bodies).

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::provider::{self, AiProviderConfig, AiProviderKind};
use super::transport;

pub const MAX_DISCOVERED_MODELS: usize = 500;
const MAX_MODEL_ID_LEN: usize = 256;

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

/// Short completion used by draft tests and validation.
pub fn probe_request(config: &AiProviderConfig) -> AiChatCompleteRequest {
    AiChatCompleteRequest {
        provider_id: config.id.clone(),
        model: Some(config.default_model.clone()),
        messages: vec![AiChatMessage {
            role: "user".into(),
            content: "Reply with OK.".into(),
        }],
        temperature: Some(0.0),
        max_tokens: Some(128),
    }
}

pub fn provider_http_error(status: reqwest::StatusCode, body: &str) -> String {
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/code")
                .or_else(|| value.pointer("/error/type"))
                .or_else(|| value.pointer("/error/status"))
                .and_then(|item| item.as_str())
                .map(|item| {
                    item.chars()
                        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
                        .take(48)
                        .collect::<String>()
                })
                .filter(|item| !item.is_empty())
        });
    // Only the provider's error code: its message can echo the prompt (SQL, data).
    match code {
        Some(code) => format!("AI_CHAT_FAILED: {status} {code}"),
        None => format!("AI_CHAT_FAILED: {status}"),
    }
}

async fn post_json(
    config: &AiProviderConfig,
    path: &str,
    payload: &serde_json::Value,
    headers: &[(&str, &str)],
    bearer: Option<&str>,
) -> Result<serde_json::Value, String> {
    let url = provider::endpoint(config, path)?;
    let client = transport::client_for(&url, transport::CHAT_TIMEOUT)?;
    let mut builder = client.post(url).json(payload);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    if let Some(token) = bearer {
        builder = builder.bearer_auth(token);
    }
    let response = builder
        .send()
        .await
        .map_err(|e| transport::request_error(&e))?;
    let status = response.status();
    transport::reject_redirect(status)?;
    let body = response
        .text()
        .await
        .map_err(|_| "AI_CHAT_RESPONSE_READ_FAILED".to_string())?;
    if !status.is_success() {
        return Err(provider_http_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|_| "AI_CHAT_RESPONSE_JSON_FAILED".to_string())
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
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: Option<&str>,
) -> Result<String, String> {
    let model = request.model.as_deref().unwrap_or(&config.default_model);
    let is_groq_gpt_oss =
        matches!(config.kind, AiProviderKind::Groq) && model.starts_with("openai/gpt-oss-");
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
        payload["reasoning_effort"] = json!("low");
        payload["include_reasoning"] = json!(false);
    } else if let Some(max_tokens) = request.max_tokens {
        payload["max_tokens"] = json!(max_tokens);
    }
    let value = post_json(config, "chat/completions", &payload, &[], api_key).await?;
    let text = first_text_from_openai_like(&value);
    if text.is_empty() {
        let finish_reason = value
            .pointer("/choices/0/finish_reason")
            .and_then(|reason| reason.as_str());
        if finish_reason == Some("length") {
            return Err("AI_CHAT_OUTPUT_TOKEN_LIMIT: model produced no final content".into());
        }
    }
    Ok(text)
}

/// Current Claude models (Opus 5.5 and later) always think, and `max_tokens` covers
/// thinking plus the answer, so small limits leave no room for any text.
const ANTHROPIC_MIN_MAX_TOKENS: u32 = 4096;

/// Messages API payload. No sampling parameters: Claude Opus 5.5+ rejects any
/// non-default `temperature`/`top_p`/`top_k` with a 400, and older models accept their
/// defaults. An empty system prompt is omitted.
fn anthropic_payload(
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
) -> serde_json::Value {
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
    let mut payload = json!({
        "model": request.model.as_deref().unwrap_or(&config.default_model),
        "max_tokens": request.max_tokens.unwrap_or(1024).max(ANTHROPIC_MIN_MAX_TOKENS),
        "messages": messages,
    });
    if !system.trim().is_empty() {
        payload["system"] = json!(system);
    }
    payload
}

/// Text of a Messages API response; `thinking` blocks (always present on newer models)
/// are skipped.
fn anthropic_text(value: &serde_json::Value) -> String {
    value
        .get("content")
        .and_then(|content| content.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|item| item.get("type").and_then(|v| v.as_str()) == Some("text"))
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

async fn complete_anthropic(
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: &str,
) -> Result<String, String> {
    let payload = anthropic_payload(config, request);
    let headers = [("x-api-key", api_key), ("anthropic-version", "2023-06-01")];
    let value = post_json(config, "messages", &payload, &headers, None).await?;
    Ok(anthropic_text(&value))
}

async fn complete_gemini(
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: &str,
) -> Result<String, String> {
    let model = request.model.as_deref().unwrap_or(&config.default_model);
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
    let path = format!("models/{}:generateContent", urlencoding::encode(model));
    let headers = [("x-goog-api-key", api_key)];
    let value = post_json(config, &path, &payload, &headers, None).await?;
    Ok(value
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(|text| text.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

pub async fn complete(
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: Option<&str>,
) -> Result<String, String> {
    match config.kind {
        AiProviderKind::Anthropic => {
            complete_anthropic(config, request, api_key.unwrap_or_default()).await
        }
        AiProviderKind::Gemini => {
            complete_gemini(config, request, api_key.unwrap_or_default()).await
        }
        _ => complete_openai_like(config, request, api_key).await,
    }
}

/// Model ids from `GET <base>/models` (OpenAI-compatible `{"data":[{"id":..}]}`).
pub async fn list_models(
    config: &AiProviderConfig,
    api_key: Option<&str>,
) -> Result<Vec<String>, String> {
    let url = provider::endpoint(config, "models")?;
    let client = transport::client_for(&url, transport::DISCOVERY_TIMEOUT)?;
    let mut builder = client.get(url);
    if let Some(token) = api_key {
        builder = builder.bearer_auth(token);
    }
    let response = builder
        .send()
        .await
        .map_err(|e| transport::request_error(&e))?;
    let status = response.status();
    transport::reject_redirect(status)?;
    let body = transport::read_body_limited(response, transport::DISCOVERY_MAX_BYTES).await?;
    if !status.is_success() {
        return Err(provider_http_error(status, &body));
    }
    parse_model_ids(&body)
}

fn parse_model_ids(body: &str) -> Result<Vec<String>, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "AI_PROVIDER_MODELS_INVALID".to_string())?;
    let items = value
        .get("data")
        .and_then(|data| data.as_array())
        .ok_or_else(|| "AI_PROVIDER_MODELS_INVALID".to_string())?;
    let mut ids = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(|id| id.as_str()).map(str::trim) else {
            continue;
        };
        if id.is_empty() || id.len() > MAX_MODEL_ID_LEN || ids.iter().any(|seen| seen == id) {
            continue;
        }
        ids.push(id.to_string());
        if ids.len() == MAX_DISCOVERED_MODELS {
            break;
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::tests::provider;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// One-shot loopback server; returns the port and the raw request it received.
    fn serve_once(response: String) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let _ = stream.write_all(response.as_bytes());
        });
        (port, rx)
    }

    fn http_ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn local(port: u16) -> AiProviderConfig {
        provider::normalize_fields(provider(
            AiProviderKind::Ollama,
            &format!("http://127.0.0.1:{port}"),
        ))
    }

    fn anthropic_config() -> AiProviderConfig {
        provider::normalize_fields(provider(
            AiProviderKind::Anthropic,
            "https://api.anthropic.com",
        ))
    }

    #[test]
    fn anthropic_payload_has_no_sampling_params_or_empty_system() {
        let config = anthropic_config();
        let mut probe = probe_request(&config);
        probe.model = Some("claude-opus-5-5".into());
        let payload = anthropic_payload(&config, &probe);
        // Opus 5.5+ rejects non-default temperature/top_p/top_k with a 400.
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("top_p").is_none());
        assert!(payload.get("system").is_none(), "empty system is omitted");
        // max_tokens covers thinking + text: never the tiny probe limit.
        assert_eq!(payload["max_tokens"], ANTHROPIC_MIN_MAX_TOKENS);
        assert_eq!(payload["model"], "claude-opus-5-5");

        let mut chat = probe.clone();
        chat.messages.insert(
            0,
            AiChatMessage {
                role: "system".into(),
                content: "Be brief.".into(),
            },
        );
        chat.max_tokens = Some(10_000);
        let payload = anthropic_payload(&config, &chat);
        assert_eq!(payload["system"], "Be brief.");
        assert_eq!(payload["max_tokens"], 10_000);
        assert_eq!(payload["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn anthropic_text_skips_thinking_blocks() {
        let value = serde_json::json!({
            "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "OK" },
                { "type": "text", "text": "!" }
            ]
        });
        assert_eq!(anthropic_text(&value), "OK!");
        assert_eq!(anthropic_text(&serde_json::json!({ "content": [] })), "");
    }

    #[test]
    fn parses_openai_compatible_model_list() {
        let ids = parse_model_ids(
            r#"{"data":[{"id":"qwen2.5-7b-instruct"},{"id":"llama3:8b"},{"id":""},{"id":"llama3:8b"},{"x":1}]}"#,
        )
        .unwrap();
        assert_eq!(ids, vec!["qwen2.5-7b-instruct", "llama3:8b"]);
        assert_eq!(
            parse_model_ids(r#"{"models":[]}"#).unwrap_err(),
            "AI_PROVIDER_MODELS_INVALID"
        );
    }

    #[test]
    fn caps_discovered_model_count() {
        let items = (0..MAX_DISCOVERED_MODELS + 10)
            .map(|i| format!(r#"{{"id":"m{i}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let ids = parse_model_ids(&format!(r#"{{"data":[{items}]}}"#)).unwrap();
        assert_eq!(ids.len(), MAX_DISCOVERED_MODELS);
    }

    #[test]
    fn redacts_provider_error_body() {
        let message = provider_http_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"prompt: SELECT * FROM secrets","code":"invalid_api_key"}}"#,
        );
        assert_eq!(message, "AI_CHAT_FAILED: 401 Unauthorized invalid_api_key");
        assert!(!message.contains("SELECT"));
    }

    #[tokio::test]
    async fn lists_models_with_optional_bearer() {
        let (port, request) = serve_once(http_ok(r#"{"data":[{"id":"local-model"}]}"#));
        let ids = list_models(&local(port), Some("tok-123")).await.unwrap();
        assert_eq!(ids, vec!["local-model"]);
        let raw = request.recv().unwrap();
        assert!(raw.starts_with("GET /v1/models "));
        assert!(raw
            .to_ascii_lowercase()
            .contains("authorization: bearer tok-123"));
    }

    #[tokio::test]
    async fn completes_against_local_openai_compatible_server() {
        let (port, request) = serve_once(http_ok(
            r#"{"choices":[{"message":{"content":" OK "},"finish_reason":"stop"}]}"#,
        ));
        let config = local(port);
        let text = complete(&config, &probe_request(&config), None)
            .await
            .unwrap();
        assert_eq!(text, "OK");
        let raw = request.recv().unwrap();
        assert!(raw.starts_with("POST /v1/chat/completions "));
        assert!(!raw.to_ascii_lowercase().contains("authorization:"));
    }

    #[tokio::test]
    async fn redirect_responses_fail_without_following() {
        let (port, _) = serve_once(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://8.8.8.8/v1/chat/completions\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        );
        let config = local(port);
        let error = complete(&config, &probe_request(&config), Some("tok"))
            .await
            .unwrap_err();
        assert_eq!(error, "AI_PROVIDER_REDIRECT_BLOCKED: 307");
    }

    #[tokio::test]
    async fn policy_rejects_before_any_request() {
        let config =
            provider::normalize_fields(provider(AiProviderKind::Ollama, "http://8.8.8.8:11434"));
        assert_eq!(
            list_models(&config, None).await.unwrap_err(),
            crate::ai::url_policy::HOST_NOT_ALLOWED
        );
    }
}
