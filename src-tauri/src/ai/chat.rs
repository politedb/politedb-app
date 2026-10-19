//! Requests to AI providers: chat completion and model discovery (plan R1, R10).
//!
//! Every request URL is re-validated against the URL policy and sent through
//! [`transport::client_for`]; errors carry codes only (no URLs, hosts, prompts or bodies).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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

/// POSTs JSON and returns the status with the (size-capped) body. No error mapping, so
/// callers can recognise specific provider signals before redacting.
pub(crate) async fn send_json(
    config: &AiProviderConfig,
    path: &str,
    payload: &serde_json::Value,
    headers: &[(&str, &str)],
    bearer: Option<&str>,
) -> Result<(reqwest::StatusCode, String), String> {
    let url = provider::endpoint(config, path)?;
    send_json_to(config, url, payload, headers, bearer).await
}

/// [`send_json`] to an already validated full URL (Ollama's native endpoints).
pub(crate) async fn send_json_to(
    config: &AiProviderConfig,
    url: url::Url,
    payload: &serde_json::Value,
    headers: &[(&str, &str)],
    bearer: Option<&str>,
) -> Result<(reqwest::StatusCode, String), String> {
    // Re-validated like every provider request (plan D12 R1).
    let url = crate::ai::url_policy::validate(url.as_str(), config.kind.class())?;
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
    let body = transport::read_body_limited(response, transport::CHAT_MAX_BYTES).await?;
    Ok((status, body))
}

async fn post_json(
    config: &AiProviderConfig,
    path: &str,
    payload: &serde_json::Value,
    headers: &[(&str, &str)],
    bearer: Option<&str>,
) -> Result<serde_json::Value, String> {
    let (status, body) = send_json(config, path, payload, headers, bearer).await?;
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

/// Output floor for Ollama chat. Local models such as qwen3 think before answering and
/// cannot always turn it off; the thinking counts against `max_tokens`, so a small
/// budget ends in HTTP 200 with empty content. Short answers stay short.
const OLLAMA_MIN_MAX_TOKENS: u32 = 4096;

fn openai_like_payload(config: &AiProviderConfig, request: &AiChatCompleteRequest) -> Value {
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
    } else if matches!(config.kind, AiProviderKind::Ollama) {
        payload["max_tokens"] = json!(request
            .max_tokens
            .unwrap_or(OLLAMA_MIN_MAX_TOKENS)
            .max(OLLAMA_MIN_MAX_TOKENS));
    } else if let Some(max_tokens) = request.max_tokens {
        payload["max_tokens"] = json!(max_tokens);
    }
    payload
}

async fn complete_openai_like(
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: Option<&str>,
) -> Result<String, String> {
    let payload = openai_like_payload(config, request);
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

/// Claude Opus 4.7 and later (and ids we cannot parse, which are assumed new) always
/// think, with `max_tokens` covering thinking plus the answer, and reject non-default
/// `temperature`/`top_p`/`top_k` with a 400. Earlier models keep the previous request
/// shape: caller temperature and token limit.
const ANTHROPIC_ALWAYS_THINKING_FROM: (u32, u32) = (4, 7);

/// Room for adaptive thinking plus a short answer on always-thinking models.
pub(crate) const ANTHROPIC_MIN_MAX_TOKENS: u32 = 4096;

/// `(major, minor)` from ids like `claude-opus-4-1-20250805`, `claude-3-5-sonnet-20241022`
/// or `claude-opus-5-5`. Date suffixes (8 digits) are not versions.
fn anthropic_version(model: &str) -> Option<(u32, u32)> {
    let rest = model.trim().strip_prefix("claude-")?;
    let mut numbers = rest
        .split('-')
        .filter(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        .filter(|part| part.len() <= 2)
        .filter_map(|part| part.parse::<u32>().ok());
    let major = numbers.next()?;
    Some((major, numbers.next().unwrap_or(0)))
}

pub(crate) fn anthropic_always_thinks(model: &str) -> bool {
    anthropic_version(model).map_or(true, |version| version >= ANTHROPIC_ALWAYS_THINKING_FROM)
}

/// Messages API payload; see [`ANTHROPIC_ALWAYS_THINKING_FROM`]. An empty system
/// prompt is omitted.
fn anthropic_payload(
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
) -> serde_json::Value {
    let model = request
        .model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or(&config.default_model);
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
    let requested = request.max_tokens.unwrap_or(1024);
    let mut payload = json!({ "model": model, "messages": messages });
    if anthropic_always_thinks(model) {
        payload["max_tokens"] = json!(requested.max(ANTHROPIC_MIN_MAX_TOKENS));
    } else {
        payload["max_tokens"] = json!(requested);
        payload["temperature"] = json!(request.temperature.unwrap_or(0.2));
    }
    if !system.trim().is_empty() {
        payload["system"] = json!(system);
    }
    payload
}

/// Text of a Messages API response. `thinking`/`redacted_thinking` blocks are skipped.
/// No text because the budget ran out, or because the model refused, gets its own code
/// (never the provider's message, which can echo the prompt).
fn anthropic_text(value: &serde_json::Value) -> Result<String, String> {
    let text = value
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
        .to_string();
    match value.get("stop_reason").and_then(|reason| reason.as_str()) {
        // A refusal may arrive with partial text; it is never a completed answer.
        Some("refusal") => Err("AI_CHAT_REFUSED".into()),
        // Truncated text is still returned, like the OpenAI-compatible path.
        Some("max_tokens") if text.is_empty() => {
            Err("AI_CHAT_OUTPUT_TOKEN_LIMIT: model produced no final content".into())
        }
        _ => Ok(text),
    }
}

async fn complete_anthropic(
    config: &AiProviderConfig,
    request: &AiChatCompleteRequest,
    api_key: &str,
) -> Result<String, String> {
    let payload = anthropic_payload(config, request);
    let headers = [("x-api-key", api_key), ("anthropic-version", "2023-06-01")];
    let value = post_json(config, "messages", &payload, &headers, None).await?;
    anthropic_text(&value)
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

    fn request_for(model: &str) -> AiChatCompleteRequest {
        let mut request = probe_request(&anthropic_config());
        request.model = Some(model.into());
        request
    }

    #[test]
    fn ollama_chat_leaves_room_to_think() {
        let config = local(11434);
        let mut request = probe_request(&config);
        for (asked, sent) in [(Some(96), 4096), (None, 4096), (Some(8192), 8192)] {
            request.max_tokens = asked;
            assert_eq!(
                openai_like_payload(&config, &request)["max_tokens"],
                sent,
                "{asked:?}"
            );
        }
        // Other OpenAI-compatible providers keep the requested budget.
        let mut openai =
            provider::normalize_fields(provider(AiProviderKind::Openai, "https://api.openai.com"));
        openai.default_model = "gpt-5".into();
        request.max_tokens = Some(96);
        assert_eq!(openai_like_payload(&openai, &request)["max_tokens"], 96);
        request.max_tokens = None;
        assert!(openai_like_payload(&openai, &request)
            .get("max_tokens")
            .is_none());
    }

    #[test]
    fn reads_claude_versions_from_model_ids() {
        assert_eq!(anthropic_version("claude-opus-5-5"), Some((5, 5)));
        assert_eq!(anthropic_version("claude-fable-5-1"), Some((5, 1)));
        assert_eq!(anthropic_version("claude-opus-4-1-20250805"), Some((4, 1)));
        assert_eq!(
            anthropic_version("claude-3-5-sonnet-20241022"),
            Some((3, 5))
        );
        assert_eq!(anthropic_version("claude-3-opus-20240229"), Some((3, 0)));
        assert_eq!(anthropic_version("claude-sonnet-4-5"), Some((4, 5)));
        assert_eq!(anthropic_version("my-proxy-model"), None);
        assert!(anthropic_always_thinks("claude-opus-4-7"));
        assert!(anthropic_always_thinks("claude-haiku-5-5"));
        assert!(!anthropic_always_thinks("claude-opus-4-6"));
        assert!(!anthropic_always_thinks("claude-3-5-sonnet-20241022"));
        // Unknown ids are treated as new: the safe request shape for current models.
        assert!(anthropic_always_thinks("my-proxy-model"));
    }

    #[test]
    fn new_claude_payload_has_no_sampling_params_and_room_to_think() {
        let payload = anthropic_payload(&anthropic_config(), &request_for("claude-opus-5-5"));
        for param in ["temperature", "top_p", "top_k"] {
            assert!(payload.get(param).is_none(), "{param} must be omitted");
        }
        assert!(payload.get("system").is_none(), "empty system is omitted");
        assert_eq!(payload["max_tokens"], ANTHROPIC_MIN_MAX_TOKENS);
        assert_eq!(payload["model"], "claude-opus-5-5");

        let mut big = request_for("claude-opus-5-5");
        big.max_tokens = Some(10_000);
        assert_eq!(
            anthropic_payload(&anthropic_config(), &big)["max_tokens"],
            10_000
        );
    }

    #[test]
    fn older_claude_payload_keeps_temperature_and_token_limit() {
        let mut request = request_for("claude-sonnet-4-5");
        request.temperature = Some(0.1);
        request.max_tokens = Some(96);
        let payload = anthropic_payload(&anthropic_config(), &request);
        assert_eq!(payload["max_tokens"], 96);
        assert!((payload["temperature"].as_f64().unwrap() - 0.1).abs() < 1e-6);

        request.temperature = None;
        request.max_tokens = None;
        let payload = anthropic_payload(&anthropic_config(), &request);
        assert_eq!(payload["max_tokens"], 1024);
        assert!((payload["temperature"].as_f64().unwrap() - 0.2).abs() < 1e-6);
    }

    #[test]
    fn payload_falls_back_to_default_model_and_maps_history() {
        let mut config = anthropic_config();
        config.default_model = "claude-sonnet-5-5".into();
        let request = AiChatCompleteRequest {
            provider_id: config.id.clone(),
            model: Some("  ".into()),
            messages: vec![
                AiChatMessage {
                    role: "system".into(),
                    content: "   ".into(),
                },
                AiChatMessage {
                    role: "user".into(),
                    content: "Q1".into(),
                },
                AiChatMessage {
                    role: "assistant".into(),
                    content: "A1".into(),
                },
                AiChatMessage {
                    role: "tool".into(),
                    content: "Q2".into(),
                },
            ],
            temperature: None,
            max_tokens: None,
        };
        let payload = anthropic_payload(&config, &request);
        assert_eq!(payload["model"], "claude-sonnet-5-5");
        assert!(
            payload.get("system").is_none(),
            "whitespace-only system is omitted"
        );
        let roles: Vec<_> = payload["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
        assert_eq!(payload["max_tokens"], ANTHROPIC_MIN_MAX_TOKENS);
    }

    #[test]
    fn response_text_skips_thinking_and_reports_why_it_is_empty() {
        let value = serde_json::json!({
            "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "redacted_thinking", "data": "xx" },
                { "type": "text", "text": "OK" },
                { "type": "text", "text": "!" }
            ],
            "stop_reason": "end_turn"
        });
        assert_eq!(anthropic_text(&value).unwrap(), "OK!");

        let truncated_with_text = serde_json::json!({
            "content": [{ "type": "text", "text": "partial" }],
            "stop_reason": "max_tokens"
        });
        assert_eq!(anthropic_text(&truncated_with_text).unwrap(), "partial");

        let thinking_only = serde_json::json!({
            "content": [{ "type": "thinking", "thinking": "..." }],
            "stop_reason": "max_tokens"
        });
        assert!(anthropic_text(&thinking_only)
            .unwrap_err()
            .starts_with("AI_CHAT_OUTPUT_TOKEN_LIMIT"));

        let refused = serde_json::json!({ "content": [], "stop_reason": "refusal" });
        assert_eq!(anthropic_text(&refused).unwrap_err(), "AI_CHAT_REFUSED");

        // Refusal with partial text (documented shape): still a refusal, and neither
        // the text nor stop_details reach the error.
        let refused_with_text = serde_json::json!({
            "content": [{ "type": "text", "text": "Hello.." }],
            "stop_reason": "refusal",
            "stop_details": { "explanation": "policy" }
        });
        assert_eq!(
            anthropic_text(&refused_with_text).unwrap_err(),
            "AI_CHAT_REFUSED"
        );

        assert_eq!(
            anthropic_text(&serde_json::json!({ "content": [] })).unwrap(),
            ""
        );
    }

    #[test]
    fn anthropic_errors_keep_the_type_but_not_the_message() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt: SELECT * FROM customers"}}"#;
        let error = provider_http_error(reqwest::StatusCode::BAD_REQUEST, body);
        assert_eq!(
            error,
            "AI_CHAT_FAILED: 400 Bad Request invalid_request_error"
        );
        assert!(!error.contains("customers"));
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
