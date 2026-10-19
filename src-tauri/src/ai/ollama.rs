//! Ollama server identification, model metadata and native error classification
//! (plan ollama-native-context A2', A4, A4', C1, C4/D2, A6).
//!
//! Probes send no conversation data: only `GET /api/version`, the existing model list,
//! and `POST /api/show {model}`. Each uses the probe client (1 s connect, 2 s total,
//! 64 KiB body, no redirects, no proxy for http, localhost pinned) and returns fixed
//! codes only; server text is never surfaced.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::{FutureExt, Shared};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::generations::ProviderGenerations;
use super::provider::{self, AiProviderConfig};
use super::transport;

/// First release with the `truncate` and `shift` chat flags (ollama/ollama#12582, v0.12.6).
pub const MIN_NATIVE: (u64, u64, u64) = (0, 12, 6);

pub const UPDATE_REQUIRED: &str = "AI_OLLAMA_UPDATE_REQUIRED";
pub const UNREACHABLE: &str = "AI_PROVIDER_UNREACHABLE";
pub const MODEL_INFO_UNAVAILABLE: &str = "AI_OLLAMA_MODEL_INFO_UNAVAILABLE";
pub const MODEL_NOT_FOUND: &str = "AI_OLLAMA_MODEL_NOT_FOUND";
pub const LOAD_FAILED: &str = "AI_OLLAMA_LOAD_FAILED";
pub const CONTEXT_FULL: &str = "AI_AGENT_CONTEXT_FULL";

/// Upper bound accepted for a model's trained context length.
const MAX_TRAINED_CONTEXT: u64 = 10_000_000;

/// What a provider of kind `ollama` actually is, decided before a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    /// Ollama ≥ [`MIN_NATIVE`] at `prefix`: the agent uses native `/api/chat`.
    Native { prefix: Url, version: String },
    /// A recognized Ollama older than [`MIN_NATIVE`].
    TooOld { version: String },
    /// Positively an OpenAI-compatible server that is not a recognized Ollama: the
    /// agent keeps the `/v1` wire, with the context size unknown.
    Compatible,
}

/// Longest version string accepted from a server (it can reach the settings UI).
const MAX_VERSION_LEN: usize = 64;

/// A SemVer numeric identifier: digits, no leading zero unless it is `0`.
fn numeric(part: &str) -> Option<u64> {
    if part.is_empty()
        || !part.bytes().all(|b| b.is_ascii_digit())
        || (part.len() > 1 && part.starts_with('0'))
    {
        return None;
    }
    part.parse().ok()
}

/// Dot-separated non-empty `[0-9A-Za-z-]` identifiers; for prereleases, numeric ones
/// must not have leading zeros.
fn identifiers(raw: &str, prerelease: bool) -> bool {
    raw.split('.').all(|part| {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !(prerelease
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.len() > 1
                && part.starts_with('0'))
    })
}

/// Strict SemVer 2.0.0 `MAJOR.MINOR.PATCH[-pre][+build]` (C1). Returns the core and
/// whether it is a prerelease; build metadata is validated, then ignored. Anything
/// else (whitespace, extra `+`, leading zeros, empty identifiers) is rejected.
fn parse_version(raw: &str) -> Option<((u64, u64, u64), bool)> {
    if raw.is_empty() || raw.len() > MAX_VERSION_LEN {
        return None;
    }
    let (rest, build) = match raw.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (raw, None),
    };
    if build.is_some_and(|build| !identifiers(build, false)) {
        return None;
    }
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    if pre.is_some_and(|pre| !identifiers(pre, true)) {
        return None;
    }
    let mut parts = core.split('.');
    let parsed = (
        numeric(parts.next()?)?,
        numeric(parts.next()?)?,
        numeric(parts.next()?)?,
    );
    if parts.next().is_some() {
        return None;
    }
    Some((parsed, pre.is_some()))
}

/// SemVer precedence against the stable [`MIN_NATIVE`]: a prerelease of the minimum
/// sorts below it (C1).
pub fn supports_native(version: &str) -> Option<bool> {
    let (core, prerelease) = parse_version(version)?;
    Some(core > MIN_NATIVE || (core == MIN_NATIVE && !prerelease))
}

enum Fetched {
    Json(reqwest::StatusCode, Value),
    /// A complete response whose body is not JSON (or empty).
    Other(reqwest::StatusCode),
}

/// One probe request; `Err` means indeterminate (timeout, connect, redirect, too large).
async fn fetch(url: Url, body: Option<&Value>) -> Result<Fetched, ()> {
    let client = transport::probe_client(&url).map_err(|_| ())?;
    let request = match body {
        Some(body) => client.post(url).json(body),
        None => client.get(url),
    };
    let response = request.send().await.map_err(|_| ())?;
    let status = response.status();
    transport::reject_redirect(status).map_err(|_| ())?;
    let text = transport::read_body_limited(response, transport::PROBE_MAX_BYTES)
        .await
        .map_err(|_| ())?;
    Ok(match serde_json::from_str::<Value>(&text) {
        Ok(value) => Fetched::Json(status, value),
        Err(_) => Fetched::Other(status),
    })
}

/// A positive OpenAI model list: `{"data": [{"id": "<string>"}, …]}` (with `object`
/// equal to `"list"` when present).
fn is_model_list(value: &Value) -> bool {
    if value
        .get("object")
        .is_some_and(|object| object.as_str() != Some("list"))
    {
        return false;
    }
    value
        .get("data")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .all(|item| item.get("id").is_some_and(Value::is_string))
        })
}

async fn compatible_or_unreachable(config: &AiProviderConfig) -> Result<Identity, String> {
    let url = provider::endpoint(config, "models").map_err(|_| UNREACHABLE.to_string())?;
    match fetch(url, None).await {
        Ok(Fetched::Json(status, value)) if status.is_success() && is_model_list(&value) => {
            Ok(Identity::Compatible)
        }
        _ => Err(UNREACHABLE.into()),
    }
}

/// The routing table A2'. Never sends conversation data.
pub async fn identify(config: &AiProviderConfig) -> Result<Identity, String> {
    let Some(prefix) = provider::ollama_server_prefix(config) else {
        // Row 6: native endpoints are not derivable from this base.
        return compatible_or_unreachable(config).await;
    };
    let url = provider::ollama_endpoint(config, &prefix, "api/version")
        .map_err(|_| UNREACHABLE.to_string())?;
    match fetch(url, None).await {
        Ok(Fetched::Json(status, value)) if status.is_success() && value.is_object() => {
            match value.get("version") {
                // Row 4: a JSON object without a version is not an Ollama answer.
                None => compatible_or_unreachable(config).await,
                Some(Value::String(version)) => match supports_native(version) {
                    Some(true) => Ok(Identity::Native {
                        prefix,
                        version: version.clone(),
                    }),
                    Some(false) => Ok(Identity::TooOld {
                        version: version.clone(),
                    }),
                    // Row 5: a version that is not SemVer.
                    None => Err(UNREACHABLE.into()),
                },
                // Row 5: a non-string version.
                Some(_) => Err(UNREACHABLE.into()),
            }
        }
        // Row 4: no such endpoint.
        Ok(Fetched::Json(status, _)) | Ok(Fetched::Other(status))
            if status == reqwest::StatusCode::NOT_FOUND =>
        {
            compatible_or_unreachable(config).await
        }
        // Row 5: everything else is indeterminate.
        _ => Err(UNREACHABLE.into()),
    }
}

/// The model's trained context length from `/api/show` (A4): exactly one
/// `*.context_length` key holding an integer in `1..=10_000_000`.
pub async fn trained_max(
    config: &AiProviderConfig,
    prefix: &Url,
    model: &str,
) -> Result<u32, String> {
    let url = provider::ollama_endpoint(config, prefix, "api/show")
        .map_err(|_| MODEL_INFO_UNAVAILABLE.to_string())?;
    let body = serde_json::json!({ "model": model });
    match fetch(url, Some(&body)).await {
        Ok(Fetched::Json(status, value)) if status.is_success() => {
            context_length(&value).ok_or_else(|| MODEL_INFO_UNAVAILABLE.to_string())
        }
        Ok(Fetched::Json(status, value)) if status == reqwest::StatusCode::NOT_FOUND => {
            Err(if is_model_not_found(&value) {
                MODEL_NOT_FOUND
            } else {
                MODEL_INFO_UNAVAILABLE
            }
            .into())
        }
        _ => Err(MODEL_INFO_UNAVAILABLE.into()),
    }
}

fn context_length(show: &Value) -> Option<u32> {
    let info = show.get("model_info")?.as_object()?;
    let mut found = info
        .iter()
        .filter(|(key, _)| key.ends_with(".context_length"));
    let (_, value) = found.next()?;
    if found.next().is_some() {
        return None;
    }
    let length = value.as_u64()?;
    if length == 0 || length > MAX_TRAINED_CONTEXT {
        return None;
    }
    Some(length.min(u32::MAX as u64) as u32)
}

fn error_text(value: &Value) -> Option<&str> {
    value.get("error").and_then(Value::as_str).map(str::trim)
}

fn is_model_not_found(value: &Value) -> bool {
    error_text(value)
        .is_some_and(|text| text.starts_with("model '") && text.contains("' not found"))
}

/// `request (<digits> tokens) exceeds the available context size (<digits> tokens)`.
fn is_numeric_context_error(text: &str) -> bool {
    fn digits_then<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
        let end = text.bytes().take_while(u8::is_ascii_digit).count();
        if end == 0 {
            return None;
        }
        text[end..].strip_prefix(suffix)
    }
    text.strip_prefix("request (")
        .and_then(|rest| digits_then(rest, " tokens) exceeds the available context size ("))
        .and_then(|rest| digits_then(rest, " tokens)"))
        .is_some()
}

/// Maps a native `/api/chat` error response to a fixed code (C4/D2, A4'), or `None`
/// for the generic request failure. Code only: the body is never returned.
pub fn classify_chat_error(status: reqwest::StatusCode, body: &str) -> Option<&'static str> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let text = error_text(&value)?;
    if status == reqwest::StatusCode::BAD_REQUEST
        && (text.starts_with("the input length exceeds the context length")
            || is_numeric_context_error(text))
    {
        return Some(CONTEXT_FULL);
    }
    if status == reqwest::StatusCode::NOT_FOUND && is_model_not_found(&value) {
        return Some(MODEL_NOT_FOUND);
    }
    if (status.is_client_error() || status.is_server_error())
        && text.contains("requires more system memory")
    {
        return Some(LOAD_FAILED);
    }
    None
}

// ------------------------------------------------------------------ settings status

/// What the settings dialog shows for an Ollama provider draft (C5). Fixed fields only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub kind: &'static str,
    pub version: Option<String>,
    pub trained_max: Option<u32>,
    /// `min(setting or default, trained_max)`: the `num_ctx` a run would send.
    pub effective: Option<u32>,
}

impl ServerStatus {
    fn of(kind: &'static str) -> Self {
        Self {
            kind,
            version: None,
            trained_max: None,
            effective: None,
        }
    }
}

/// The status of an (unsaved) Ollama draft. Uses the same routing and metadata rules
/// as a run, without the run cache (a draft may differ from the saved config).
pub async fn server_status(config: &AiProviderConfig) -> ServerStatus {
    if config.kind != provider::AiProviderKind::Ollama {
        return ServerStatus::of("not_ollama_kind");
    }
    match identify(config).await {
        Err(_) => ServerStatus::of("unreachable"),
        Ok(Identity::Compatible) => ServerStatus::of("compatible"),
        Ok(Identity::TooOld { version }) => ServerStatus {
            version: Some(version),
            ..ServerStatus::of("too_old")
        },
        Ok(Identity::Native { prefix, version }) => {
            let base = ServerStatus {
                version: Some(version),
                ..ServerStatus::of("native")
            };
            if config.default_model.is_empty() {
                return ServerStatus {
                    kind: "native_no_model",
                    ..base
                };
            }
            match trained_max(config, &prefix, &config.default_model).await {
                Ok(trained) => ServerStatus {
                    trained_max: Some(trained),
                    effective: Some(provider::requested_context_size(config).min(trained)),
                    ..base
                },
                Err(code) if code == MODEL_NOT_FOUND => ServerStatus {
                    kind: "model_not_found",
                    ..base
                },
                Err(_) => ServerStatus {
                    kind: "metadata_unavailable",
                    ..base
                },
            }
        }
    }
}

// ------------------------------------------------------------------- probe cache

const IDENTITY_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const TRAINED_MAX_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_ENTRIES: usize = 256;
/// Probe lookups in flight across both caches.
const MAX_IN_FLIGHT: usize = 8;
/// A lookup never outlives this, whoever waits for it.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
pub const PREPARATION_CANCELED: &str = "AI_AGENT_CANCELED";

pub trait ProbeKey: Clone + Eq + Hash + Send + Sync + 'static {
    fn provider_id(&self) -> &str;
    fn generation(&self) -> u64;
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IdentityKey {
    pub provider_id: String,
    pub generation: u64,
    /// The saved base URL the identity was learned for.
    pub base: String,
}

impl ProbeKey for IdentityKey {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }
    fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TrainedMaxKey {
    pub provider_id: String,
    pub generation: u64,
    pub prefix: String,
    pub model: String,
}

impl ProbeKey for TrainedMaxKey {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }
    fn generation(&self) -> u64 {
        self.generation
    }
}

type Lookup<V> = Shared<Pin<Box<dyn Future<Output = Result<V, String>> + Send>>>;

struct Inner<K, V> {
    entries: HashMap<K, (V, Instant, u64)>,
    in_flight: HashMap<K, (u64, Lookup<V>)>,
    next_seq: u64,
}

impl<K, V> Default for Inner<K, V> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            in_flight: HashMap::new(),
            next_seq: 0,
        }
    }
}

/// A TTL cache of probe results with one shared lookup per key (A6). The lookup is
/// owned by the cache: a waiter that is cancelled detaches, and the lookup finishes
/// (bounded by [`LOOKUP_TIMEOUT`]) for the others.
pub struct ProbeCache<K, V> {
    generations: Arc<ProviderGenerations>,
    in_flight_total: Arc<AtomicUsize>,
    ttl: Duration,
    inner: Mutex<Inner<K, V>>,
}

/// Removes the in-flight entry it was created for, on success, error or panic.
struct InFlightGuard<K: ProbeKey, V: Clone + Send + Sync + 'static> {
    cache: Arc<ProbeCache<K, V>>,
    key: K,
    seq: u64,
}

impl<K: ProbeKey, V: Clone + Send + Sync + 'static> Drop for InFlightGuard<K, V> {
    fn drop(&mut self) {
        let mut inner = self.cache.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner
            .in_flight
            .get(&self.key)
            .is_some_and(|(seq, _)| *seq == self.seq)
        {
            inner.in_flight.remove(&self.key);
        }
        drop(inner);
        self.cache.in_flight_total.fetch_sub(1, Ordering::SeqCst);
    }
}

impl<K: ProbeKey, V: Clone + Send + Sync + 'static> ProbeCache<K, V> {
    pub fn new(
        generations: Arc<ProviderGenerations>,
        in_flight_total: Arc<AtomicUsize>,
        ttl: Duration,
    ) -> Self {
        Self {
            generations,
            in_flight_total,
            ttl,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn fresh(&self, inner: &Inner<K, V>, key: &K) -> Option<V> {
        inner
            .entries
            .get(key)
            .filter(|(_, at, _)| at.elapsed() < self.ttl)
            .map(|(value, _, _)| value.clone())
    }

    /// Stores `value` if the key's generation is still current (generations lock, then
    /// the cache lock). Evicts expired entries, then the oldest-inserted, when full.
    fn publish(&self, key: &K, value: V) {
        self.generations
            .publish_if_current(key.provider_id(), key.generation(), || {
                let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                let ttl = self.ttl;
                inner.entries.retain(|_, (_, at, _)| at.elapsed() < ttl);
                if inner.entries.len() >= MAX_ENTRIES && !inner.entries.contains_key(key) {
                    if let Some(oldest) = inner
                        .entries
                        .iter()
                        .min_by_key(|(_, (_, _, seq))| *seq)
                        .map(|(k, _)| k.clone())
                    {
                        inner.entries.remove(&oldest);
                    }
                }
                inner.next_seq += 1;
                let seq = inner.next_seq;
                inner
                    .entries
                    .insert(key.clone(), (value, Instant::now(), seq));
            });
    }

    /// Drops every entry of a provider (its config changed).
    pub fn forget_provider(&self, provider_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .entries
            .retain(|key, _| key.provider_id() != provider_id);
    }

    /// The cached value, or the shared lookup's result. `cacheable` decides which
    /// results are stored (indeterminate failures are not). A cancelled waiter gets
    /// [`PREPARATION_CANCELED`] and detaches.
    pub async fn get_or_lookup<F>(
        self: &Arc<Self>,
        key: K,
        cacheable: fn(&Result<V, String>) -> bool,
        lookup: F,
        cancel: &CancellationToken,
    ) -> Result<V, String>
    where
        F: Future<Output = Result<V, String>> + Send + 'static,
    {
        let shared = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(value) = self.fresh(&inner, &key) {
                return Ok(value);
            }
            match inner.in_flight.get(&key) {
                Some((_, shared)) => shared.clone(),
                None => {
                    if self.in_flight_total.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
                        self.in_flight_total.fetch_sub(1, Ordering::SeqCst);
                        return Err(UNREACHABLE.into());
                    }
                    inner.next_seq += 1;
                    let seq = inner.next_seq;
                    let guard = InFlightGuard {
                        cache: Arc::clone(self),
                        key: key.clone(),
                        seq,
                    };
                    let cache = Arc::clone(self);
                    let task_key = key.clone();
                    let handle = tokio::spawn(async move {
                        let _guard = guard;
                        let result = tokio::time::timeout(LOOKUP_TIMEOUT, lookup)
                            .await
                            .unwrap_or_else(|_| Err(UNREACHABLE.into()));
                        if cacheable(&result) {
                            if let Ok(value) = &result {
                                cache.publish(&task_key, value.clone());
                            }
                        }
                        result
                    });
                    let future: Pin<Box<dyn Future<Output = Result<V, String>> + Send>> =
                        Box::pin(async move {
                            handle.await.unwrap_or_else(|_| Err(UNREACHABLE.into()))
                        });
                    let shared = future.shared();
                    inner.in_flight.insert(key, (seq, shared.clone()));
                    shared
                }
            }
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(PREPARATION_CANCELED.into()),
            result = shared => result,
        }
    }
}

/// The two probe caches, sharing the provider generations and the in-flight cap.
pub struct OllamaProbeCache {
    pub identity: Arc<ProbeCache<IdentityKey, Identity>>,
    pub trained_max: Arc<ProbeCache<TrainedMaxKey, u32>>,
}

impl OllamaProbeCache {
    pub fn new(generations: Arc<ProviderGenerations>) -> Self {
        let total = Arc::new(AtomicUsize::new(0));
        Self {
            identity: Arc::new(ProbeCache::new(
                generations.clone(),
                total.clone(),
                IDENTITY_TTL,
            )),
            trained_max: Arc::new(ProbeCache::new(generations, total, TRAINED_MAX_TTL)),
        }
    }

    pub fn forget_provider(&self, provider_id: &str) {
        self.identity.forget_provider(provider_id);
        self.trained_max.forget_provider(provider_id);
    }
}

/// Native, TooOld and Compatible are cached; indeterminate failures never are.
pub fn identity_cacheable(result: &Result<Identity, String>) -> bool {
    result.is_ok()
}

/// Only a valid trained maximum is cached.
pub fn trained_max_cacheable(result: &Result<u32, String>) -> bool {
    result.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{tests::provider, AiProviderKind};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn version_precedence_follows_semver() {
        for (version, native) in [
            ("0.12.5", Some(false)),
            ("0.12.6-rc1", Some(false)),
            ("0.12.6", Some(true)),
            ("0.12.6+build.7", Some(true)),
            ("0.12.7-rc1", Some(true)),
            ("0.40.4", Some(true)),
            ("1.0.0", Some(true)),
            ("0.9.99", Some(false)),
            ("abc", None),
            ("12", None),
            ("0.12", None),
            ("0.12.6.1", None),
            ("0.12.x", None),
            ("0.12.6-", None),
            ("", None),
            // Strict grammar: malformed versions never pass or reach the UI.
            ("0.12.6+", None),
            ("0.12.6+a+b", None),
            ("00.12.6", None),
            ("0.012.6", None),
            ("0.12.7-rc..1", None),
            ("0.12.7-rc.01", None),
            ("0.12.7-rc_1", None),
            ("0.12.6+synthetic\nPRIVATE_PROVIDER_TEXT", None),
            (" 0.12.6", None),
            ("0.12.6 ", None),
            ("0.12.6+build.007", Some(true)),
            ("0.12.7-rc.1", Some(true)),
            ("0.12.6-0", Some(false)),
        ] {
            assert_eq!(supports_native(version), native, "{version}");
        }
        let long = format!("0.12.6+{}", "a".repeat(MAX_VERSION_LEN));
        assert_eq!(supports_native(&long), None);
    }

    #[test]
    fn chat_errors_map_to_fixed_codes_only() {
        use reqwest::StatusCode as S;
        let bad = S::BAD_REQUEST;
        for body in [
            r#"{"error":"the input length exceeds the context length"}"#,
            r#"{"error":"the input length exceeds the context length\n"}"#,
            r#"{"error":"request (6011 tokens) exceeds the available context size (4096 tokens), try increasing it"}"#,
        ] {
            assert_eq!(classify_chat_error(bad, body), Some(CONTEXT_FULL), "{body}");
        }
        for (status, body) in [
            (bad, r#"{"error":"Bad request"}"#),
            (bad, r#"{"error":"bad request: secret SQL here"}"#),
            (
                S::PAYLOAD_TOO_LARGE,
                r#"{"error":"request body must not exceed 32 MiB"}"#,
            ),
            (
                S::PAYLOAD_TOO_LARGE,
                r#"{"error":"the input length exceeds the context length"}"#,
            ),
            (S::INTERNAL_SERVER_ERROR, r#"{"error":"backend failed"}"#),
            (
                bad,
                r#"{"error":"request (x tokens) exceeds the available context size (4096 tokens)"}"#,
            ),
            (bad, "not json"),
        ] {
            assert_eq!(classify_chat_error(status, body), None, "{status} {body}");
        }
        assert_eq!(
            classify_chat_error(
                S::INTERNAL_SERVER_ERROR,
                r#"{"error":"model requires more system memory (12 GiB) than is available"}"#
            ),
            Some(LOAD_FAILED)
        );
        assert_eq!(
            classify_chat_error(S::NOT_FOUND, r#"{"error":"model 'x:1b' not found"}"#),
            Some(MODEL_NOT_FOUND)
        );
    }

    #[test]
    fn trained_max_needs_exactly_one_valid_key() {
        let show = |info: Value| serde_json::json!({ "model_info": info });
        assert_eq!(
            context_length(&show(
                serde_json::json!({"qwen3.context_length": 262144, "qwen3.block_count": 36})
            )),
            Some(262144)
        );
        for info in [
            serde_json::json!({}),
            serde_json::json!({"a.context_length": 0}),
            serde_json::json!({"a.context_length": -1}),
            serde_json::json!({"a.context_length": "4096"}),
            serde_json::json!({"a.context_length": 4096.5}),
            serde_json::json!({"a.context_length": 20_000_000}),
            serde_json::json!({"a.context_length": 4096, "b.context_length": 8192}),
        ] {
            assert_eq!(context_length(&show(info.clone())), None, "{info}");
        }
        assert_eq!(context_length(&serde_json::json!({})), None);
    }

    #[test]
    fn model_lists_must_be_well_formed() {
        assert!(is_model_list(
            &serde_json::json!({"object":"list","data":[{"id":"m"}]})
        ));
        assert!(is_model_list(&serde_json::json!({"data":[]})));
        assert!(!is_model_list(
            &serde_json::json!({"object":"model","data":[]})
        ));
        assert!(!is_model_list(&serde_json::json!({"data":[{"id":1}]})));
        assert!(!is_model_list(&serde_json::json!({"models":[]})));
    }

    // ------------------------------------------------------------ routing (A2')

    /// A loopback server answering by request path; records the paths it saw.
    fn server(routes: Vec<(&'static str, String)>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(path.clone());
                let response = routes
                    .iter()
                    .find(|(p, _)| *p == path)
                    .map(|(_, r)| r.clone())
                    .unwrap_or_else(|| {
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_string()
                    });
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, seen)
    }

    fn ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn status(code: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {code}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn ollama_at(base: String) -> AiProviderConfig {
        let mut config = provider(AiProviderKind::Ollama, "http://unused");
        config.host = None;
        config.sub_path = None;
        config.base_url = Some(base);
        provider::normalize_fields(config)
    }

    fn no_chat(seen: &Arc<Mutex<Vec<String>>>) {
        let seen = seen.lock().unwrap();
        assert!(
            seen.iter()
                .all(|p| !p.ends_with("/chat") && !p.ends_with("/chat/completions")),
            "{seen:?}"
        );
    }

    /// Server routes, the saved base path, and the expected outcome.
    type RouteCase = (
        Vec<(&'static str, String)>,
        &'static str,
        Result<&'static str, &'static str>,
    );

    #[tokio::test]
    async fn routing_table_rows() {
        let list = r#"{"object":"list","data":[{"id":"m"}]}"#;
        let cases: Vec<RouteCase> = vec![
            (
                vec![("/api/version", ok(r#"{"version":"0.12.6"}"#))],
                "/v1",
                Ok("native"),
            ),
            (
                vec![("/api/version", ok(r#"{"version":"0.40.4"}"#))],
                "/v1",
                Ok("native"),
            ),
            (
                vec![("/api/version", ok(r#"{"version":"0.12.5"}"#))],
                "/v1",
                Ok("too_old"),
            ),
            (
                vec![("/api/version", ok(r#"{"version":"0.12.6-rc1"}"#))],
                "/v1",
                Ok("too_old"),
            ),
            (
                vec![("/api/version", ok(r#"{"version":"abc"}"#))],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![("/api/version", ok(r#"{"version":12}"#))],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![(
                    "/api/version",
                    ok(r#"{"version":"0.12.6+x\nSELECT secret"}"#),
                )],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![("/api/version", ok(r#"{"version":"00.40.4"}"#))],
                "/v1",
                Err(UNREACHABLE),
            ),
            // No /api/version (404), then a valid model list: compatible.
            (vec![("/v1/models", ok(list))], "/v1", Ok("compatible")),
            // JSON without a version, then a valid list.
            (
                vec![
                    ("/api/version", ok(r#"{"name":"x"}"#)),
                    ("/v1/models", ok(list)),
                ],
                "/v1",
                Ok("compatible"),
            ),
            // 404, then an invalid list.
            (
                vec![("/v1/models", ok(r#"{"models":[]}"#))],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![("/api/version", status("401 Unauthorized", ""))],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![("/api/version", status("500 Internal Server Error", ""))],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![("/api/version", status("302 Found", ""))],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![("/api/version", ok("not json"))],
                "/v1",
                Err(UNREACHABLE),
            ),
            (
                vec![(
                    "/api/version",
                    ok(&format!(r#"{{"version":"{}"}}"#, "9".repeat(70_000))),
                )],
                "/v1",
                Err(UNREACHABLE),
            ),
            // A custom prefix keeps its path.
            (
                vec![("/x/api/version", ok(r#"{"version":"0.13.0"}"#))],
                "/x/v1",
                Ok("native"),
            ),
            // A base without /v1: native is not derivable; only a model list makes it compatible.
            (
                vec![("/custom/models", ok(list))],
                "/custom",
                Ok("compatible"),
            ),
            (vec![], "/custom", Err(UNREACHABLE)),
        ];
        for (routes, base_path, expected) in cases {
            let label = format!(
                "{base_path} {:?}",
                routes.iter().map(|(p, _)| *p).collect::<Vec<_>>()
            );
            let (port, seen) = server(routes);
            let config = ollama_at(format!("http://127.0.0.1:{port}{base_path}"));
            let outcome = identify(&config).await;
            let got = match &outcome {
                Ok(Identity::Native { .. }) => Ok("native"),
                Ok(Identity::TooOld { .. }) => Ok("too_old"),
                Ok(Identity::Compatible) => Ok("compatible"),
                Err(code) => Err(code.as_str()),
            };
            assert_eq!(got, expected, "{label}");
            no_chat(&seen);
            if let Ok(Identity::Native { prefix, .. }) = outcome {
                assert_eq!(prefix.port(), Some(port));
                assert!(prefix.path().starts_with(base_path.trim_end_matches("/v1")));
            }
        }
    }

    #[tokio::test]
    async fn timeouts_are_unreachable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let held: Vec<_> = listener.incoming().take(2).collect();
            std::thread::sleep(Duration::from_secs(5));
            drop(held);
        });
        let config = ollama_at(format!("http://127.0.0.1:{port}/v1"));
        assert_eq!(identify(&config).await, Err(UNREACHABLE.into()));
    }

    #[tokio::test]
    async fn trained_max_lookup() {
        let (port, _) = server(vec![(
            "/api/show",
            ok(r#"{"model_info":{"qwen3.context_length":40960}}"#),
        )]);
        let config = ollama_at(format!("http://127.0.0.1:{port}/v1"));
        let prefix = provider::ollama_server_prefix(&config).unwrap();
        assert_eq!(trained_max(&config, &prefix, "qwen3:4b").await, Ok(40960));

        let (port, _) = server(vec![(
            "/api/show",
            status("404 Not Found", r#"{"error":"model 'nope' not found"}"#),
        )]);
        let config = ollama_at(format!("http://127.0.0.1:{port}/v1"));
        let prefix = provider::ollama_server_prefix(&config).unwrap();
        assert_eq!(
            trained_max(&config, &prefix, "nope").await,
            Err(MODEL_NOT_FOUND.into())
        );

        let (port, _) = server(vec![("/api/show", ok(r#"{"model_info":{}}"#))]);
        let config = ollama_at(format!("http://127.0.0.1:{port}/v1"));
        let prefix = provider::ollama_server_prefix(&config).unwrap();
        assert_eq!(
            trained_max(&config, &prefix, "m").await,
            Err(MODEL_INFO_UNAVAILABLE.into())
        );
    }

    #[tokio::test]
    async fn settings_status_kinds() {
        let version = |v: &str| ok(&format!(r#"{{"version":"{v}"}}"#));
        let show = ok(r#"{"model_info":{"qwen3.context_length":8192}}"#);
        let (port, _) = server(vec![
            ("/api/version", version("0.40.4")),
            ("/api/show", show.clone()),
        ]);
        let mut config = ollama_at(format!("http://127.0.0.1:{port}/v1"));
        let native = server_status(&config).await;
        assert_eq!(native.kind, "native");
        assert_eq!(native.version.as_deref(), Some("0.40.4"));
        assert_eq!(
            (native.trained_max, native.effective),
            (Some(8192), Some(8192))
        );
        config.context_size = Some(4096);
        assert_eq!(server_status(&config).await.effective, Some(4096));
        config.default_model.clear();
        assert_eq!(server_status(&config).await.kind, "native_no_model");

        let (port, _) = server(vec![("/api/version", version("0.12.5"))]);
        assert_eq!(
            server_status(&ollama_at(format!("http://127.0.0.1:{port}/v1")))
                .await
                .kind,
            "too_old"
        );
        let (port, _) = server(vec![
            ("/api/version", version("0.40.4")),
            (
                "/api/show",
                status("404 Not Found", r#"{"error":"model 'model-a' not found"}"#),
            ),
        ]);
        assert_eq!(
            server_status(&ollama_at(format!("http://127.0.0.1:{port}/v1")))
                .await
                .kind,
            "model_not_found"
        );
        let (port, _) = server(vec![
            ("/api/version", version("0.40.4")),
            ("/api/show", ok("{}")),
        ]);
        assert_eq!(
            server_status(&ollama_at(format!("http://127.0.0.1:{port}/v1")))
                .await
                .kind,
            "metadata_unavailable"
        );
        let (port, _) = server(vec![("/v1/models", ok(r#"{"data":[]}"#))]);
        assert_eq!(
            server_status(&ollama_at(format!("http://127.0.0.1:{port}/v1")))
                .await
                .kind,
            "compatible"
        );
        let (port, _) = server(vec![]);
        assert_eq!(
            server_status(&ollama_at(format!("http://127.0.0.1:{port}/v1")))
                .await
                .kind,
            "unreachable"
        );

        let openai =
            provider::normalize_fields(provider(AiProviderKind::Openai, "https://api.openai.com"));
        assert_eq!(server_status(&openai).await.kind, "not_ollama_kind");
    }

    /// Answers `/api/version` (native) and hangs on `hang_path`.
    fn hanging_server(hang_path: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    if path == hang_path {
                        std::thread::sleep(Duration::from_secs(10));
                        return;
                    }
                    let _ = stream.write_all(ok(r#"{"version":"0.40.4"}"#).as_bytes());
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn status_requests_cancel_during_each_probe_and_clean_up() {
        use crate::ai::cancel::{run_cancellable, CancelRegistry};
        for hang in ["/api/version", "/api/show"] {
            let port = hanging_server(hang);
            let config = ollama_at(format!("http://127.0.0.1:{port}/v1"));
            let registry = Arc::new(CancelRegistry::default());
            let canceller = {
                let registry = registry.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    registry.cancel("status-1");
                })
            };
            let started = Instant::now();
            let result = run_cancellable(&registry, "status-1", "CANCELED", async {
                Ok(server_status(&config).await)
            })
            .await;
            canceller.await.unwrap();
            assert_eq!(result, Err("CANCELED".to_string()), "{hang}");
            assert!(started.elapsed() < Duration::from_secs(1), "{hang}");
            assert_eq!(registry.active_len(), 0, "{hang}");
        }
        // Success and error exits also leave nothing registered.
        let registry = CancelRegistry::default();
        let (port, _) = server(vec![("/api/version", ok(r#"{"version":"0.12.5"}"#))]);
        let config = ollama_at(format!("http://127.0.0.1:{port}/v1"));
        let done = run_cancellable(&registry, "s", "CANCELED", async {
            Ok(server_status(&config).await)
        })
        .await
        .unwrap();
        assert_eq!(done.kind, "too_old");
        let failed: Result<(), String> =
            run_cancellable(&registry, "s", "CANCELED", async { Err("BAD".to_string()) }).await;
        assert_eq!(failed, Err("BAD".into()));
        assert_eq!(registry.active_len(), 0);
    }

    // ------------------------------------------------------------- cache (A6)

    fn cache(ttl: Duration) -> (Arc<ProviderGenerations>, Arc<ProbeCache<IdentityKey, u32>>) {
        let gens = Arc::new(ProviderGenerations::default());
        let cache = Arc::new(ProbeCache::new(
            gens.clone(),
            Arc::new(AtomicUsize::new(0)),
            ttl,
        ));
        (gens, cache)
    }

    fn key(gens: &ProviderGenerations, provider: &str) -> IdentityKey {
        IdentityKey {
            provider_id: provider.into(),
            generation: gens.current(provider),
            base: "b".into(),
        }
    }

    fn always(_: &Result<u32, String>) -> bool {
        true
    }
    fn only_ok(result: &Result<u32, String>) -> bool {
        result.is_ok()
    }

    #[tokio::test]
    async fn cold_cache_then_hit() {
        let (gens, cache) = cache(Duration::from_secs(60));
        let token = CancellationToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let calls = calls.clone();
            let value = cache
                .get_or_lookup(
                    key(&gens, "p"),
                    always,
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(7)
                    },
                    &token,
                )
                .await;
            assert_eq!(value, Ok(7));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failures_marked_uncacheable_are_retried() {
        let (gens, cache) = cache(Duration::from_secs(60));
        let token = CancellationToken::new();
        let first = cache
            .get_or_lookup(
                key(&gens, "p"),
                only_ok,
                async { Err(UNREACHABLE.to_string()) },
                &token,
            )
            .await;
        assert_eq!(first, Err(UNREACHABLE.into()));
        let second = cache
            .get_or_lookup(key(&gens, "p"), only_ok, async { Ok(3) }, &token)
            .await;
        assert_eq!(second, Ok(3));
    }

    #[tokio::test]
    async fn expiry_triggers_a_new_lookup() {
        let (gens, cache) = cache(Duration::from_millis(30));
        let token = CancellationToken::new();
        assert_eq!(
            cache
                .get_or_lookup(key(&gens, "p"), always, async { Ok(1) }, &token)
                .await,
            Ok(1)
        );
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(
            cache
                .get_or_lookup(key(&gens, "p"), always, async { Ok(2) }, &token)
                .await,
            Ok(2)
        );
    }

    #[tokio::test]
    async fn a_save_during_a_lookup_drops_the_late_result() {
        let (gens, cache) = cache(Duration::from_secs(60));
        let token = CancellationToken::new();
        let stale_key = key(&gens, "p");
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let waiter = {
            let cache = cache.clone();
            let token = token.clone();
            let stale_key = stale_key.clone();
            tokio::spawn(async move {
                cache
                    .get_or_lookup(
                        stale_key,
                        always,
                        async move {
                            let _ = release_rx.await;
                            Ok(1)
                        },
                        &token,
                    )
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        gens.bump("p");
        cache.forget_provider("p");
        release_tx.send(()).unwrap();
        assert_eq!(waiter.await.unwrap(), Ok(1));
        // Not stored under the stale generation, and the new generation looks up anew.
        assert!(cache.inner.lock().unwrap().entries.is_empty());
        assert_eq!(
            cache
                .get_or_lookup(key(&gens, "p"), always, async { Ok(2) }, &token)
                .await,
            Ok(2)
        );
    }

    #[tokio::test]
    async fn concurrent_misses_share_one_lookup_and_a_cancelled_waiter_detaches() {
        let (gens, cache) = cache(Duration::from_secs(60));
        let calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));
        let make = |calls: Arc<AtomicUsize>,
                    rx: Arc<Mutex<Option<tokio::sync::oneshot::Receiver<()>>>>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let rx = rx.lock().unwrap().take();
            if let Some(rx) = rx {
                let _ = rx.await;
            }
            Ok(9)
        };
        let cancelled = CancellationToken::new();
        let a = {
            let (cache, k, c, r, t) = (
                cache.clone(),
                key(&gens, "p"),
                calls.clone(),
                release_rx.clone(),
                cancelled.clone(),
            );
            tokio::spawn(async move { cache.get_or_lookup(k, always, make(c, r), &t).await })
        };
        let b = {
            let (cache, k, c, r) = (
                cache.clone(),
                key(&gens, "p"),
                calls.clone(),
                release_rx.clone(),
            );
            tokio::spawn(async move {
                cache
                    .get_or_lookup(k, always, make(c, r), &CancellationToken::new())
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancelled.cancel();
        assert_eq!(a.await.unwrap(), Err(PREPARATION_CANCELED.into()));
        release_tx.send(()).unwrap();
        assert_eq!(b.await.unwrap(), Ok(9));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "one shared lookup");
    }

    #[tokio::test]
    async fn a_panicking_lookup_fails_waiters_and_stays_retryable() {
        let (gens, cache) = cache(Duration::from_secs(60));
        let token = CancellationToken::new();
        let result = cache
            .get_or_lookup(key(&gens, "p"), always, async { panic!("boom") }, &token)
            .await;
        assert_eq!(result, Err(UNREACHABLE.into()));
        assert!(cache.inner.lock().unwrap().in_flight.is_empty());
        assert_eq!(cache.in_flight_total.load(Ordering::SeqCst), 0);
        assert_eq!(
            cache
                .get_or_lookup(key(&gens, "p"), always, async { Ok(5) }, &token)
                .await,
            Ok(5)
        );
    }

    #[tokio::test]
    async fn the_in_flight_cap_fails_closed() {
        let (gens, cache) = cache(Duration::from_secs(60));
        let token = CancellationToken::new();
        let mut held = Vec::new();
        let mut releases = Vec::new();
        for i in 0..MAX_IN_FLIGHT {
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            releases.push(tx);
            let cache = cache.clone();
            let k = key(&gens, &format!("p{i}"));
            let token = token.clone();
            held.push(tokio::spawn(async move {
                cache
                    .get_or_lookup(
                        k,
                        always,
                        async move {
                            let _ = rx.await;
                            Ok(1)
                        },
                        &token,
                    )
                    .await
            }));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            cache
                .get_or_lookup(key(&gens, "extra"), always, async { Ok(1) }, &token)
                .await,
            Err(UNREACHABLE.into())
        );
        for tx in releases {
            let _ = tx.send(());
        }
        for h in held {
            assert_eq!(h.await.unwrap(), Ok(1));
        }
        assert_eq!(cache.in_flight_total.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn eviction_when_full_of_live_entries() {
        let (gens, cache) = cache(Duration::from_secs(60));
        let token = CancellationToken::new();
        for i in 0..=MAX_ENTRIES {
            let k = key(&gens, &format!("p{i}"));
            cache
                .get_or_lookup(k, always, async move { Ok(i as u32) }, &token)
                .await
                .unwrap();
        }
        let inner = cache.inner.lock().unwrap();
        assert_eq!(inner.entries.len(), MAX_ENTRIES);
        assert!(
            !inner.entries.keys().any(|k| k.provider_id == "p0"),
            "oldest evicted"
        );
    }
}
