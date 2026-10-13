//! The model port of the agent and its HTTP implementation (plan ai-agent R2).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;

use super::protocol::{AssistantEnvelope, StepRequest};
use super::wire::{self, Wire, RESPONSE_INVALID};
use crate::ai::chat::{provider_http_error, send_json};
use crate::ai::provider::AiProviderConfig;

/// The provider or model cannot call tools: the frontend uses the legacy assistant.
pub const TOOLS_UNSUPPORTED: &str = "AI_AGENT_TOOLS_UNSUPPORTED";
/// The provider kind has no verified tool-calling contract in v1 (plan R2 matrix).
pub const PROVIDER_UNSUPPORTED: &str = "AI_AGENT_PROVIDER_UNSUPPORTED";

#[async_trait]
pub trait AgentModel: Send + Sync {
    async fn step(&self, request: &StepRequest<'_>) -> Result<AssistantEnvelope, String>;

    /// The smallest output allowance the wire will actually send for `model` (adapters
    /// raise smaller requests to it), so the coordinator budgets what is really used.
    fn min_output_tokens(&self, _model: &str) -> u32 {
        0
    }
}

pub struct HttpModel {
    config: AiProviderConfig,
    key: Option<String>,
    wire: Wire,
}

impl HttpModel {
    pub fn new(config: AiProviderConfig, key: Option<String>) -> Result<Self, String> {
        let wire = wire::wire_for(config.kind).ok_or_else(|| PROVIDER_UNSUPPORTED.to_string())?;
        Ok(Self { config, key, wire })
    }
}

#[async_trait]
impl AgentModel for HttpModel {
    fn min_output_tokens(&self, model: &str) -> u32 {
        wire::min_output_tokens(self.config.kind, model)
    }

    async fn step(&self, request: &StepRequest<'_>) -> Result<AssistantEnvelope, String> {
        let (path, body) = wire::build(self.wire, self.config.kind, request)?;
        let key = self.key.as_deref().unwrap_or_default();
        let (status, text) = match self.wire {
            Wire::Anthropic => {
                let headers = [("x-api-key", key), ("anthropic-version", "2023-06-01")];
                send_json(&self.config, &path, &body, &headers, None).await?
            }
            Wire::Gemini => {
                let headers = [("x-goog-api-key", key)];
                send_json(&self.config, &path, &body, &headers, None).await?
            }
            Wire::OpenAi => send_json(&self.config, &path, &body, &[], self.key.as_deref()).await?,
        };
        if !status.is_success() {
            if tools_unsupported(status, &text) {
                return Err(TOOLS_UNSUPPORTED.into());
            }
            // Code-only, as for chat: provider messages can echo the prompt.
            return Err(provider_http_error(status, &text));
        }
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| RESPONSE_INVALID.to_string())?;
        wire::parse(self.wire, self.config.kind, request.model, &value)
    }
}

/// Only explicit "this model has no tool support" signals count: Ollama's structured
/// `{"error": "<model> does not support tools"}`. Auth, rate-limit, network and generic
/// 400 errors never downgrade a provider, and the phrase merely appearing elsewhere in
/// a body (an echoed prompt) does not count (plan R2).
fn tools_unsupported(status: reqwest::StatusCode, body: &str) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    match value.get("error") {
        // Ollama: `{"error":"<model> does not support tools"}`.
        Some(serde_json::Value::String(error)) => error
            .to_ascii_lowercase()
            .ends_with("does not support tools"),
        // OpenAI-compatible: only structured tool-parameter rejection codes.
        Some(serde_json::Value::Object(error)) => {
            let param = error.get("param").and_then(|p| p.as_str()).unwrap_or("");
            let code = error.get("code").and_then(|c| c.as_str()).unwrap_or("");
            matches!(param, "tools" | "tool_choice")
                && matches!(
                    code,
                    "unsupported_parameter" | "unsupported_value" | "invalid_value"
                )
        }
        _ => false,
    }
}

const CAPABILITY_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Provider id, model, base URL, and the provider's config generation when the run
/// started: a run that started before a config change cannot write a stale answer.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CapabilityKey {
    provider_id: String,
    model: String,
    base_url: String,
    generation: u64,
}

/// Whether a model can call tools, learned from real requests (plan R2): `true` once a
/// request declaring tools succeeded, `false` on an explicit "unsupported" signal.
/// Entries expire after a day; saving or deleting a provider forgets it.
#[derive(Default)]
pub struct CapabilityCache {
    inner: Mutex<CacheInner>,
}

#[derive(Default)]
struct CacheInner {
    entries: HashMap<CapabilityKey, (bool, Instant)>,
    generations: HashMap<String, u64>,
}

impl CapabilityCache {
    pub fn key(&self, config: &AiProviderConfig, model: &str) -> CapabilityKey {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        CapabilityKey {
            provider_id: config.id.clone(),
            model: model.to_string(),
            base_url: config.base_url.clone().unwrap_or_default(),
            generation: inner.generations.get(&config.id).copied().unwrap_or(0),
        }
    }

    pub fn get(&self, key: &CapabilityKey) -> Option<bool> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .entries
            .get(key)
            .filter(|(_, at)| at.elapsed() < CAPABILITY_TTL)
            .map(|(supported, _)| *supported)
    }

    pub fn record(&self, key: CapabilityKey, supported: bool) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let current = inner
            .generations
            .get(&key.provider_id)
            .copied()
            .unwrap_or(0);
        if key.generation != current {
            // The provider changed while this run was in flight.
            return;
        }
        inner
            .entries
            .retain(|_, (_, at)| at.elapsed() < CAPABILITY_TTL);
        inner.entries.insert(key, (supported, Instant::now()));
    }

    /// Forget everything about a provider (its config was saved or deleted).
    pub fn forget_provider(&self, provider_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *inner
            .generations
            .entry(provider_id.to_string())
            .or_insert(0) += 1;
        inner
            .entries
            .retain(|key, _| key.provider_id != provider_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn only_explicit_signals_mean_tools_unsupported() {
        let ollama = r#"{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}"#;
        assert!(tools_unsupported(StatusCode::BAD_REQUEST, ollama));
        assert!(!tools_unsupported(StatusCode::UNAUTHORIZED, ollama));
        assert!(!tools_unsupported(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"type":"invalid_request_error"}}"#
        ));
        assert!(!tools_unsupported(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limited"
        ));
        // The phrase echoed inside an unrelated error does not count.
        assert!(!tools_unsupported(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"bad prompt: my model does not support tools"}}"#
        ));
        assert!(!tools_unsupported(
            StatusCode::BAD_REQUEST,
            r#"{"error":"prompt 'x does not support tools' is too long, sorry"}"#
        ));
        assert!(tools_unsupported(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"type":"invalid_request_error","param":"tools","code":"unsupported_parameter","message":"tools is not supported"}}"#
        ));
        assert!(!tools_unsupported(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"type":"invalid_request_error","param":"temperature","code":"unsupported_parameter"}}"#
        ));
    }

    fn config(base: &str) -> AiProviderConfig {
        let mut config =
            crate::ai::provider::tests::provider(crate::ai::provider::AiProviderKind::Ollama, base);
        config.base_url = Some(format!("{base}/v1"));
        config
    }

    #[test]
    fn capability_cache_is_per_provider_model_and_url() {
        let cache = CapabilityCache::default();
        let a = cache.key(&config("http://a"), "m");
        let b = cache.key(&config("http://b"), "m");
        cache.record(a.clone(), false);
        assert_eq!(cache.get(&a), Some(false));
        assert_eq!(cache.get(&b), None, "a different URL is a different server");
        cache.forget_provider("p1");
        assert_eq!(cache.get(&a), None);
    }

    #[test]
    fn a_run_from_before_a_config_change_cannot_write_the_cache() {
        let cache = CapabilityCache::default();
        let stale = cache.key(&config("http://a"), "m");
        cache.forget_provider("p1"); // saved while the run was in flight
        cache.record(stale.clone(), false);
        let fresh = cache.key(&config("http://a"), "m");
        assert_eq!(cache.get(&fresh), None);
        cache.record(fresh.clone(), true);
        assert_eq!(cache.get(&fresh), Some(true));
    }

    #[test]
    fn unverified_providers_are_rejected_up_front() {
        let mut config = crate::ai::provider::tests::provider(
            crate::ai::provider::AiProviderKind::Openrouter,
            "https://openrouter.ai",
        );
        config.default_model = "x".into();
        assert_eq!(
            HttpModel::new(config, None).err().as_deref(),
            Some(PROVIDER_UNSUPPORTED)
        );
    }

    // ------------------------------------------- HTTP fixtures (loopback Ollama)

    /// Serves one canned HTTP response on loopback after reading the full request.
    fn serve_once(status: &'static str, headers: String, body: Vec<u8>) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let head = format!("HTTP/1.1 {status}\r\n{headers}Connection: close\r\n\r\n");
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        });
        port
    }

    fn json_response(status: &'static str, body: &str) -> u16 {
        serve_once(
            status,
            format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ),
            body.as_bytes().to_vec(),
        )
    }

    fn ollama_model(port: u16) -> HttpModel {
        let config = crate::ai::provider::normalize_fields(crate::ai::provider::tests::provider(
            crate::ai::provider::AiProviderKind::Ollama,
            &format!("http://127.0.0.1:{port}"),
        ));
        HttpModel::new(config, None).unwrap()
    }

    async fn step_once(model: &HttpModel) -> Result<AssistantEnvelope, String> {
        use crate::ai::agent::protocol::{ToolSpec, Turn};
        let turns = [Turn::User("tables?".into())];
        let tools = [ToolSpec {
            name: "list_tables".into(),
            description: "List tables".into(),
            parameters: serde_json::json!({ "type": "object" }),
        }];
        model
            .step(&StepRequest {
                model: "qwen3",
                system: "sys",
                turns: &turns,
                tools: &tools,
                allow_tools: true,
                max_tokens: 256,
            })
            .await
    }

    #[tokio::test]
    async fn http_tool_call_fixture_round_trips() {
        use crate::ai::agent::protocol::StopReason;
        let port = json_response(
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"c1","function":{"name":"list_tables","arguments":{}}}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
        );
        let env = step_once(&ollama_model(port)).await.unwrap();
        assert_eq!(env.stop, StopReason::ToolUse);
        assert_eq!(env.tool_calls[0].name, "list_tables");
    }

    #[tokio::test]
    async fn http_tools_unsupported_vs_generic_400() {
        let port = json_response(
            "400 Bad Request",
            r#"{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}"#,
        );
        assert_eq!(
            step_once(&ollama_model(port)).await.err().as_deref(),
            Some(TOOLS_UNSUPPORTED)
        );

        let port = json_response(
            "400 Bad Request",
            r#"{"error":{"type":"invalid_request_error","message":"secret prompt echo"}}"#,
        );
        let error = step_once(&ollama_model(port)).await.unwrap_err();
        assert_eq!(
            error,
            "AI_CHAT_FAILED: 400 Bad Request invalid_request_error"
        );
        assert!(
            !error.contains("secret"),
            "provider messages are never surfaced"
        );
    }

    #[tokio::test]
    async fn http_oversized_responses_are_rejected() {
        let max = crate::ai::transport::CHAT_MAX_BYTES;
        // Declared too large: rejected before reading.
        let port = serve_once(
            "200 OK",
            format!("Content-Length: {}\r\n", max + 1),
            Vec::new(),
        );
        assert_eq!(
            step_once(&ollama_model(port)).await.err().as_deref(),
            Some("AI_PROVIDER_RESPONSE_TOO_LARGE")
        );
        // No length header: capped while streaming.
        let port = serve_once("200 OK", String::new(), vec![b' '; max + 1]);
        assert_eq!(
            step_once(&ollama_model(port)).await.err().as_deref(),
            Some("AI_PROVIDER_RESPONSE_TOO_LARGE")
        );
    }

    #[tokio::test]
    async fn http_malformed_json_is_invalid_not_a_crash() {
        let port = json_response("200 OK", r#"{"choices":[{"message":"#);
        assert_eq!(
            step_once(&ollama_model(port)).await.err().as_deref(),
            Some(RESPONSE_INVALID)
        );
    }

    /// Live round trip against a real provider: tool call → tool result (replaying the
    /// provider-native assistant turn) → final answer. Ignored by default; run with
    ///
    /// ```text
    /// AGENT_SMOKE_KIND=anthropic AGENT_SMOKE_KEY=sk-ant-... AGENT_SMOKE_MODEL=claude-opus-5-5 \
    ///   cargo test live_agent_smoke -- --ignored --nocapture
    /// ```
    ///
    /// Kinds: openai, anthropic, gemini, groq, ollama. Optional AGENT_SMOKE_HOST /
    /// AGENT_SMOKE_SUBPATH override the defaults (e.g. a LAN Ollama).
    #[tokio::test]
    #[ignore]
    async fn live_agent_smoke() {
        use crate::ai::agent::protocol::{StepRequest, StopReason, ToolResult, ToolSpec, Turn};
        use crate::ai::provider::{self, AiProviderKind};

        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let kind = match var("AGENT_SMOKE_KIND").as_deref() {
            Some("openai") => AiProviderKind::Openai,
            Some("anthropic") => AiProviderKind::Anthropic,
            Some("gemini") => AiProviderKind::Gemini,
            Some("groq") => AiProviderKind::Groq,
            Some("ollama") => AiProviderKind::Ollama,
            other => panic!("set AGENT_SMOKE_KIND (got {other:?})"),
        };
        let (host, sub_path) = match kind {
            AiProviderKind::Openai => ("https://api.openai.com", "/v1"),
            AiProviderKind::Anthropic => ("https://api.anthropic.com", "/v1"),
            AiProviderKind::Gemini => ("https://generativelanguage.googleapis.com", "/v1beta"),
            AiProviderKind::Groq => ("https://api.groq.com", "/openai/v1"),
            _ => ("http://127.0.0.1:11434", "/v1"),
        };
        let mut config =
            provider::tests::provider(kind, &var("AGENT_SMOKE_HOST").unwrap_or(host.into()));
        config.sub_path = Some(var("AGENT_SMOKE_SUBPATH").unwrap_or(sub_path.into()));
        let config = provider::normalize_fields(config);
        let model_id = var("AGENT_SMOKE_MODEL").expect("set AGENT_SMOKE_MODEL");
        let model = HttpModel::new(config, var("AGENT_SMOKE_KEY")).unwrap();

        let tools = [ToolSpec {
            name: "get_row_count".into(),
            description: "Returns the number of rows in a table.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "table": { "type": "string" } },
                "required": ["table"]
            }),
        }];
        let system = "Use the tools to answer. Reply with just the number.";
        let mut turns = vec![Turn::User("How many rows are in the orders table?".into())];

        let first = model
            .step(&StepRequest {
                model: &model_id,
                system,
                turns: &turns,
                tools: &tools,
                allow_tools: true,
                max_tokens: 1024,
            })
            .await
            .expect("first step");
        assert_eq!(first.stop, StopReason::ToolUse, "expected a tool call");
        let call = first.tool_calls[0].clone();
        assert_eq!(call.name, "get_row_count");
        turns.push(Turn::Assistant(first));
        turns.push(Turn::ToolResults(vec![ToolResult {
            call_id: call.id,
            name: call.name,
            content: "1234".into(),
            is_error: false,
        }]));

        let second = model
            .step(&StepRequest {
                model: &model_id,
                system,
                turns: &turns,
                tools: &tools,
                allow_tools: false,
                max_tokens: 1024,
            })
            .await
            .expect("second step");
        println!(
            "answer: {:?} stop: {:?} usage: {:?}",
            second.text, second.stop, second.usage
        );
        assert_eq!(second.stop, StopReason::EndTurn);
        assert!(second.text.contains("1234") || second.text.contains("1,234"));
    }
}
