//! The model port of the agent and its HTTP implementation (plan ai-agent R2).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use url::Url;

use super::protocol::{AssistantEnvelope, StepRequest};
use super::wire::{self, Wire, RESPONSE_INVALID};
use crate::ai::chat::{provider_http_error, send_json, send_json_to};
use crate::ai::generations::ProviderGenerations;
use crate::ai::ollama;
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

/// Where and how an Ollama native run sends its requests: the `/api/chat` URL under
/// the saved base's prefix, and the context size snapshotted for the run.
#[derive(Debug, Clone, PartialEq)]
pub struct NativeTarget {
    pub chat_url: Url,
    pub num_ctx: u32,
}

pub struct HttpModel {
    config: AiProviderConfig,
    key: Option<String>,
    wire: Wire,
    native: Option<NativeTarget>,
}

impl HttpModel {
    /// The provider kind's default wire (Ollama: the `/v1` compatibility wire).
    pub fn new(config: AiProviderConfig, key: Option<String>) -> Result<Self, String> {
        let wire = wire::wire_for(config.kind).ok_or_else(|| PROVIDER_UNSUPPORTED.to_string())?;
        Ok(Self {
            config,
            key,
            wire,
            native: None,
        })
    }

    /// Ollama's native `/api/chat` wire, for a server identified as native.
    pub fn ollama_native(config: AiProviderConfig, target: NativeTarget) -> Self {
        Self {
            config,
            key: None,
            wire: Wire::OllamaNative,
            native: Some(target),
        }
    }

    #[cfg(test)]
    pub fn wire(&self) -> Wire {
        self.wire
    }

    #[cfg(test)]
    pub fn native_target(&self) -> Option<&NativeTarget> {
        self.native.as_ref()
    }
}

#[async_trait]
impl AgentModel for HttpModel {
    fn min_output_tokens(&self, model: &str) -> u32 {
        wire::min_output_tokens(self.config.kind, model)
    }

    async fn step(&self, request: &StepRequest<'_>) -> Result<AssistantEnvelope, String> {
        if let Some(target) = &self.native {
            return self.step_native(target, request).await;
        }
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
            // Native requests go through `step_native` (never reached).
            Wire::OllamaNative => return Err(RESPONSE_INVALID.into()),
        };
        Self::finish(self.wire, self.config.kind, request.model, status, &text)
    }
}

impl HttpModel {
    async fn step_native(
        &self,
        target: &NativeTarget,
        request: &StepRequest<'_>,
    ) -> Result<AssistantEnvelope, String> {
        let body = super::wire_ollama::body(request, target.num_ctx)?;
        let (status, text) =
            send_json_to(&self.config, target.chat_url.clone(), &body, &[], None).await?;
        if !status.is_success() {
            // A recognized context/load/model error wins over the generic "does not
            // support tools" suffix match: an appended phrase must never turn a context
            // failure into a capability downgrade or a legacy fallback.
            if let Some(code) = ollama::classify_chat_error(status, &text) {
                return Err(code.into());
            }
            if tools_unsupported(status, &text) {
                return Err(TOOLS_UNSUPPORTED.into());
            }
            return Err(provider_http_error(status, &text));
        }
        Self::finish(self.wire, self.config.kind, request.model, status, &text)
    }

    fn finish(
        wire: Wire,
        kind: crate::ai::provider::AiProviderKind,
        model: &str,
        status: reqwest::StatusCode,
        text: &str,
    ) -> Result<AssistantEnvelope, String> {
        if !status.is_success() {
            if tools_unsupported(status, text) {
                return Err(TOOLS_UNSUPPORTED.into());
            }
            // Code-only, as for chat: provider messages can echo the prompt.
            return Err(provider_http_error(status, text));
        }
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|_| RESPONSE_INVALID.to_string())?;
        wire::parse(wire, kind, model, &value)
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

/// Provider id, model, the wire and destination the answer applies to, and the
/// provider's config generation when the run started: a run that started before a
/// config change cannot write a stale answer, and what one wire learned never applies
/// to another (plan ollama-native-context A7).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CapabilityKey {
    provider_id: String,
    model: String,
    wire: Wire,
    destination: String,
    generation: u64,
}

impl CapabilityKey {
    pub fn new(
        provider_id: &str,
        model: &str,
        wire: Wire,
        destination: &str,
        generation: u64,
    ) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            model: model.to_string(),
            wire,
            destination: destination.to_string(),
            generation,
        }
    }

    /// The key for `config`'s default wire and saved base URL.
    pub fn for_default_wire(
        config: &AiProviderConfig,
        model: &str,
        generation: u64,
    ) -> Option<Self> {
        let wire = wire::wire_for(config.kind)?;
        Some(Self::new(
            &config.id,
            model,
            wire,
            config.base_url.as_deref().unwrap_or_default(),
            generation,
        ))
    }
}

/// Whether a model can call tools, learned from real requests (plan R2): `true` once a
/// request declaring tools succeeded, `false` on an explicit "unsupported" signal.
/// Entries expire after a day; saving or deleting a provider bumps its generation
/// (stale keys stop matching) and drops its entries.
pub struct CapabilityCache {
    generations: Arc<ProviderGenerations>,
    entries: Mutex<HashMap<CapabilityKey, (bool, Instant)>>,
}

impl Default for CapabilityCache {
    fn default() -> Self {
        Self::with_generations(Arc::new(ProviderGenerations::default()))
    }
}

impl CapabilityCache {
    pub fn with_generations(generations: Arc<ProviderGenerations>) -> Self {
        Self {
            generations,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn generation(&self, provider_id: &str) -> u64 {
        self.generations.current(provider_id)
    }

    pub fn get(&self, key: &CapabilityKey) -> Option<bool> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries
            .get(key)
            .filter(|(_, at)| at.elapsed() < CAPABILITY_TTL)
            .map(|(supported, _)| *supported)
    }

    /// Stores the answer only if the run's generation is still current (generations
    /// lock first, then this cache's lock).
    pub fn record(&self, key: CapabilityKey, supported: bool) {
        let (provider_id, generation) = (key.provider_id.clone(), key.generation);
        self.generations
            .publish_if_current(&provider_id, generation, || {
                let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
                entries.retain(|_, (_, at)| at.elapsed() < CAPABILITY_TTL);
                entries.insert(key, (supported, Instant::now()));
            });
    }

    /// Forget everything about a provider (its config was saved or deleted). Bumps the
    /// shared generation; the app uses `AppState::forget_ai_provider`, which also
    /// clears the other caches.
    #[cfg(test)]
    pub fn forget_provider(&self, provider_id: &str) {
        self.generations.bump(provider_id);
        self.drop_entries(provider_id);
    }

    pub fn drop_entries(&self, provider_id: &str) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|key, _| key.provider_id != provider_id);
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

    fn key_of(cache: &CapabilityCache, config: &AiProviderConfig, model: &str) -> CapabilityKey {
        CapabilityKey::for_default_wire(config, model, cache.generation(&config.id)).unwrap()
    }

    #[test]
    fn capability_cache_is_per_provider_model_and_url() {
        let cache = CapabilityCache::default();
        let a = key_of(&cache, &config("http://a"), "m");
        let b = key_of(&cache, &config("http://b"), "m");
        cache.record(a.clone(), false);
        assert_eq!(cache.get(&a), Some(false));
        assert_eq!(cache.get(&b), None, "a different URL is a different server");
        cache.forget_provider("p1");
        assert_eq!(cache.get(&a), None);
    }

    #[test]
    fn a_run_from_before_a_config_change_cannot_write_the_cache() {
        let cache = CapabilityCache::default();
        let stale = key_of(&cache, &config("http://a"), "m");
        cache.forget_provider("p1"); // saved while the run was in flight
        cache.record(stale.clone(), false);
        let fresh = key_of(&cache, &config("http://a"), "m");
        assert_eq!(cache.get(&fresh), None);
        cache.record(fresh.clone(), true);
        assert_eq!(cache.get(&fresh), Some(true));
    }

    #[test]
    fn what_one_wire_learned_never_applies_to_another() {
        let cache = CapabilityCache::default();
        let generation = cache.generation("p1");
        let compat = CapabilityKey::new("p1", "m", Wire::OpenAi, "http://a/v1", generation);
        let native = CapabilityKey::new("p1", "m", Wire::OllamaNative, "http://a/", generation);
        cache.record(compat.clone(), false);
        assert_eq!(cache.get(&compat), Some(false));
        assert_eq!(
            cache.get(&native),
            None,
            "a /v1 negative does not block native"
        );
        cache.record(native.clone(), true);
        assert_eq!(cache.get(&compat), Some(false));
        assert_eq!(cache.get(&native), Some(true));
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

    // ------------------------------------- native Ollama over HTTP (A1, A3, A5, D2)

    type Captured = std::sync::Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>;

    /// Answers each connection with the next response; records path and JSON body.
    fn native_server(
        bind: &str,
        responses: Vec<(&'static str, String)>,
    ) -> Option<(std::net::SocketAddr, Captured)> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(bind).ok()?;
        let addr = listener.local_addr().unwrap();
        let captured: Captured = Default::default();
        let log = captured.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 65536];
                loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
                            let json =
                                serde_json::from_slice(&request[end + 4..]).unwrap_or_default();
                            log.lock().unwrap().push((path, json));
                            break;
                        }
                    }
                }
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        Some((addr, captured))
    }

    fn native_model(base: &str, num_ctx: u32) -> HttpModel {
        let mut config = crate::ai::provider::tests::provider(
            crate::ai::provider::AiProviderKind::Ollama,
            "http://unused",
        );
        config.host = None;
        config.sub_path = None;
        config.base_url = Some(base.into());
        let config = crate::ai::provider::normalize_fields(config);
        let prefix = crate::ai::provider::ollama_server_prefix(&config).unwrap();
        let chat_url = crate::ai::provider::ollama_endpoint(&config, &prefix, "api/chat").unwrap();
        HttpModel::ollama_native(config, NativeTarget { chat_url, num_ctx })
    }

    const NATIVE_CALLS: &str = r#"{"done":true,"done_reason":"stop","prompt_eval_count":120,"eval_count":40,
        "message":{"role":"assistant","content":"","thinking":"t","tool_calls":[
        {"id":"call_a","function":{"index":0,"name":"list_tables","arguments":{"schema":"public"}}},
        {"id":"call_b","function":{"index":1,"name":"list_tables","arguments":{"schema":"audit"}}}]}}"#;
    const NATIVE_ANSWER: &str = r#"{"done":true,"done_reason":"stop","prompt_eval_count":300,"eval_count":20,
        "message":{"role":"assistant","content":"Two schemas."}}"#;

    #[tokio::test]
    async fn native_round_trip_over_http_keeps_flags_and_size_on_every_step() {
        use crate::ai::agent::protocol::{StopReason, ToolResult, ToolSpec, Turn};
        let mut executed = 0;
        for (bind, base_path) in [
            ("127.0.0.1:0", "/v1"),
            ("127.0.0.1:0", "/x/v1"),
            ("[::1]:0", "/v1"),
        ] {
            let server = native_server(
                bind,
                vec![
                    ("200 OK", NATIVE_CALLS.into()),
                    ("200 OK", NATIVE_ANSWER.into()),
                ],
            );
            let Some((addr, captured)) = server else {
                // Only the IPv6 case may be skipped, and it says so; the IPv4 cases are
                // mandatory and fail loudly when the listener cannot bind.
                assert!(bind.starts_with('['), "IPv4 loopback must bind: {bind}");
                eprintln!("skipped: IPv6 loopback unavailable on this machine");
                continue;
            };
            executed += 1;
            let base = format!("http://{addr}{base_path}");
            let model = native_model(&base, 8192);
            let tools = [ToolSpec {
                name: "list_tables".into(),
                description: "List tables".into(),
                parameters: serde_json::json!({"type": "object"}),
            }];
            let mut turns = vec![Turn::User("tables?".into())];
            let first = model
                .step(&StepRequest {
                    model: "model-a",
                    system: "sys",
                    turns: &turns,
                    tools: &tools,
                    allow_tools: true,
                    max_tokens: 1024,
                })
                .await
                .unwrap();
            assert_eq!(first.stop, StopReason::ToolUse);
            turns.push(Turn::Assistant(first.clone()));
            turns.push(Turn::ToolResults(
                first
                    .tool_calls
                    .iter()
                    .map(|c| ToolResult {
                        call_id: c.id.clone(),
                        name: c.name.clone(),
                        content: "[]".into(),
                        is_error: false,
                    })
                    .collect(),
            ));
            let last = model
                .step(&StepRequest {
                    model: "model-a",
                    system: "sys",
                    turns: &turns,
                    tools: &tools,
                    allow_tools: false,
                    max_tokens: 512,
                })
                .await
                .unwrap();
            assert_eq!(last.text, "Two schemas.");
            let captured = captured.lock().unwrap();
            let prefix = if base.contains("/x/") { "/x" } else { "" };
            for (path, body) in captured.iter() {
                assert_eq!(path, &format!("{prefix}/api/chat"), "{base}");
                assert_eq!(body["truncate"], serde_json::json!(false));
                assert_eq!(body["shift"], serde_json::json!(false));
                assert_eq!(body["stream"], serde_json::json!(false));
                assert_eq!(body["options"]["num_ctx"], serde_json::json!(8192));
                assert!(body.get("think").is_none());
            }
            assert!(captured[0].1.get("tools").is_some());
            let final_body = &captured[1].1;
            assert!(final_body.get("tools").is_none(), "final step omits tools");
            assert_eq!(final_body["options"]["num_predict"], serde_json::json!(512));
            let messages = final_body["messages"].as_array().unwrap();
            assert_eq!(
                messages[2]["thinking"],
                serde_json::json!("t"),
                "verbatim replay"
            );
            assert_eq!(messages[3]["tool_call_id"], serde_json::json!("call_a"));
            assert_eq!(messages[4]["tool_call_id"], serde_json::json!("call_b"));
        }
        assert!(executed >= 2, "mandatory IPv4 cases ran ({executed})");
    }

    #[tokio::test]
    async fn native_errors_map_to_fixed_codes_over_http() {
        let secret = " SELECT * FROM customers sk-live-123";
        let cases: Vec<(&'static str, String, &str)> = vec![
            ("400 Bad Request", format!(r#"{{"error":"the input length exceeds the context length{secret}"}}"#), "AI_AGENT_CONTEXT_FULL"),
            ("400 Bad Request", r#"{"error":"request (6011 tokens) exceeds the available context size (4096 tokens), try increasing it"}"#.into(), "AI_AGENT_CONTEXT_FULL"),
            // A recognized context error wins over the tools suffix (no false downgrade).
            ("400 Bad Request", r#"{"error":"the input length exceeds the context length: does not support tools"}"#.into(), "AI_AGENT_CONTEXT_FULL"),
            ("400 Bad Request", r#"{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}"#.into(), TOOLS_UNSUPPORTED),
            ("404 Not Found", r#"{"error":"model 'model-a' not found"}"#.into(), "AI_OLLAMA_MODEL_NOT_FOUND"),
            ("500 Internal Server Error", format!(r#"{{"error":"model requires more system memory (9 GiB){secret}"}}"#), "AI_OLLAMA_LOAD_FAILED"),
            ("413 Payload Too Large", r#"{"error":"request body must not exceed 32 MiB"}"#.into(), "AI_CHAT_FAILED: 413 Payload Too Large"),
            ("200 OK", r#"{"done":true,"message":{"role":"assistant","content":""}}"#.into(), RESPONSE_INVALID),
            ("200 OK", "not json".into(), RESPONSE_INVALID),
            ("200 OK", "x".repeat(crate::ai::transport::CHAT_MAX_BYTES + 1), "AI_PROVIDER_RESPONSE_TOO_LARGE"),
        ];
        for (status, body, expected) in cases {
            let (addr, _) = native_server("127.0.0.1:0", vec![(status, body.clone())]).unwrap();
            let model = native_model(&format!("http://{addr}/v1"), 4096);
            let error = step_once(&model).await.unwrap_err();
            assert_eq!(error, expected, "{status} {}", &body[..body.len().min(60)]);
            assert!(!error.contains("SELECT") && !error.contains("sk-live"));
        }
    }
}
