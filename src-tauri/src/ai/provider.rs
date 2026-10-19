//! AI provider configuration: types, per-kind capabilities and validation (plan D12–D14, R12).

use serde::{Deserialize, Serialize};
use url::Url;

use super::url_policy::{self, ProviderClass};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Also reads providers saved as the removed `local_openai_compatible` kind, so older
    /// `providers.json` files keep loading (their saved URL is preserved).
    #[serde(alias = "local_openai_compatible")]
    Ollama,
}

/// Whether a provider kind uses an API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyCapability {
    Required,
    None,
}

impl AiProviderKind {
    pub fn class(self) -> ProviderClass {
        match self {
            Self::Ollama => ProviderClass::Local,
            _ => ProviderClass::Cloud,
        }
    }

    pub fn key_capability(self) -> KeyCapability {
        match self {
            Self::Ollama => KeyCapability::None,
            _ => KeyCapability::Required,
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Openai => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            Self::Openrouter => "https://openrouter.ai/api/v1",
            Self::Grok => "https://api.x.ai/v1",
            Self::Groq => "https://api.groq.com/openai/v1",
            Self::Deepseek => "https://api.deepseek.com/v1",
            Self::GithubCopilot => "https://models.inference.ai.azure.com",
            Self::Ollama => "http://127.0.0.1:11434/v1",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Ollama only: the agent's context size in tokens (`num_ctx`), clamped to the
    /// model's trained maximum at run time. `None` means [`DEFAULT_CONTEXT_SIZE`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_size: Option<u32>,
}

/// Bounds and default of [`AiProviderConfig::context_size`] (plan ollama-native-context A4).
pub const MIN_CONTEXT_SIZE: u32 = 2_048;
pub const MAX_CONTEXT_SIZE: u32 = 262_144;
pub const DEFAULT_CONTEXT_SIZE: u32 = 16_384;
pub const CONTEXT_SIZE_INVALID: &str = "AI_PROVIDER_CONTEXT_SIZE_INVALID";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderFile {
    pub providers: Vec<AiProviderConfig>,
}

/// Keychain reference for a provider's API key. Always derived from the id.
pub fn key_ref(provider_id: &str) -> String {
    format!("politedb:ai:{provider_id}:api_key")
}

/// Trims fields and fills `base_url` from host/sub path or the kind default.
/// Model ids are kept exactly (only surrounding whitespace and duplicates removed).
pub fn normalize_fields(mut config: AiProviderConfig) -> AiProviderConfig {
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
    if config.kind != AiProviderKind::Ollama {
        // Meaningful for Ollama only; other kinds never carry it.
        config.context_size = None;
    }
    if config.base_url.is_none() {
        config.base_url = Some(match config.host.as_deref() {
            Some(host) => {
                let sub_path = config.sub_path.as_deref().unwrap_or("");
                format!("{host}{sub_path}")
                    .trim_end_matches('/')
                    .to_string()
            }
            None => config.kind.default_base_url().to_string(),
        });
    }
    config
}

/// Validated base URL of a normalized config (used for discovery, test and chat).
pub fn base_url(config: &AiProviderConfig) -> Result<Url, String> {
    let raw = config
        .base_url
        .as_deref()
        .unwrap_or(config.kind.default_base_url());
    url_policy::validate(raw, config.kind.class())
}

/// Full request URL under the provider base, re-validated (R1: every request).
pub fn endpoint(config: &AiProviderConfig, path: &str) -> Result<Url, String> {
    let base = base_url(config)?;
    let joined = format!(
        "{}/{}",
        base.as_str().trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    url_policy::validate(&joined, config.kind.class())
}

/// Validation for model discovery: URL and context size, no model required (R12).
pub fn validate_for_discovery(config: AiProviderConfig) -> Result<AiProviderConfig, String> {
    let config = normalize_fields(config);
    base_url(&config)?;
    validate_context_size(&config)?;
    Ok(config)
}

/// A context size, when set, must lie in `MIN_CONTEXT_SIZE..=MAX_CONTEXT_SIZE`. Checked
/// on save, on draft requests and on every run snapshot (a hand-edited file included).
pub fn validate_context_size(config: &AiProviderConfig) -> Result<(), String> {
    match config.context_size {
        Some(size) if !(MIN_CONTEXT_SIZE..=MAX_CONTEXT_SIZE).contains(&size) => {
            Err(CONTEXT_SIZE_INVALID.into())
        }
        _ => Ok(()),
    }
}

/// The agent's requested Ollama context size before clamping to the model maximum.
pub fn requested_context_size(config: &AiProviderConfig) -> u32 {
    config.context_size.unwrap_or(DEFAULT_CONTEXT_SIZE)
}

/// The Ollama server prefix `origin + P` for a validated base whose path is exactly
/// `P/v1` (plan ollama-native-context A1). `None` when the base does not end in `/v1`:
/// native endpoints are then not derivable and never guessed.
pub fn ollama_server_prefix(config: &AiProviderConfig) -> Option<Url> {
    let base = base_url(config).ok()?;
    if base.query().is_some() || base.fragment().is_some() {
        return None;
    }
    let path = base.path().trim_end_matches('/');
    let prefix = path.strip_suffix("/v1")?;
    if prefix.ends_with('/') {
        return None;
    }
    let mut url = base.clone();
    url.set_path(if prefix.is_empty() { "/" } else { prefix });
    Some(url)
}

/// A native Ollama endpoint under `prefix` (e.g. `api/chat`), re-validated like every
/// provider request. The origin and prefix of the saved base never change.
pub fn ollama_endpoint(config: &AiProviderConfig, prefix: &Url, path: &str) -> Result<Url, String> {
    let joined = format!(
        "{}/{}",
        prefix.as_str().trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    url_policy::validate(&joined, config.kind.class())
}

/// Validation for save: identity and URL; a model is optional so offline setup can be
/// saved before any model is chosen (R3). A chosen default is kept in `models`.
pub fn validate_for_save(config: AiProviderConfig) -> Result<AiProviderConfig, String> {
    let mut config = validate_for_discovery(config)?;
    if config.id.is_empty() {
        return Err("AI_PROVIDER_ID_REQUIRED".into());
    }
    if config.label.is_empty() {
        return Err("AI_PROVIDER_LABEL_REQUIRED".into());
    }
    if !config.default_model.is_empty() && !config.models.contains(&config.default_model) {
        config.models.insert(0, config.default_model.clone());
    }
    Ok(config)
}

/// Validation for completion: everything Save checks, plus a model (R12).
pub fn validate_for_completion(config: AiProviderConfig) -> Result<AiProviderConfig, String> {
    let config = validate_for_save(config)?;
    if config.default_model.is_empty() {
        return Err("AI_PROVIDER_MODEL_REQUIRED".into());
    }
    Ok(config)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn provider(kind: AiProviderKind, host: &str) -> AiProviderConfig {
        AiProviderConfig {
            id: "p1".into(),
            kind,
            label: "Provider".into(),
            base_url: None,
            host: Some(host.into()),
            sub_path: Some("/v1".into()),
            default_model: "model-a".into(),
            models: vec!["model-a".into()],
            api_key_ref: None,
            enabled: true,
            is_default: Some(false),
            context_size: None,
        }
    }

    fn ollama(base: &str) -> AiProviderConfig {
        let mut config = provider(AiProviderKind::Ollama, "http://unused");
        config.host = None;
        config.sub_path = None;
        config.base_url = Some(base.into());
        normalize_fields(config)
    }

    #[test]
    fn ollama_prefix_comes_only_from_a_v1_base() {
        let cases = [
            ("http://127.0.0.1:11434/v1", Some("http://127.0.0.1:11434/")),
            (
                "http://127.0.0.1:11434/v1/",
                Some("http://127.0.0.1:11434/"),
            ),
            (
                "http://localhost:11434/proxy/x/v1",
                Some("http://localhost:11434/proxy/x"),
            ),
            ("http://[::1]:11434/v1", Some("http://[::1]:11434/")),
            ("http://127.0.0.1:11434", None),
            ("http://127.0.0.1:11434/v1/extra", None),
            ("http://127.0.0.1:11434/api", None),
            ("http://127.0.0.1:11434/xv1", None),
        ];
        for (base, expected) in cases {
            let prefix = ollama_server_prefix(&ollama(base));
            assert_eq!(prefix.as_ref().map(Url::as_str), expected, "{base}");
        }
    }

    #[test]
    fn ollama_endpoints_keep_origin_and_prefix() {
        for (base, chat) in [
            (
                "http://127.0.0.1:11434/v1",
                "http://127.0.0.1:11434/api/chat",
            ),
            (
                "http://localhost:11434/p/q/v1/",
                "http://localhost:11434/p/q/api/chat",
            ),
        ] {
            let config = ollama(base);
            let prefix = ollama_server_prefix(&config).unwrap();
            let url = ollama_endpoint(&config, &prefix, "api/chat").unwrap();
            assert_eq!(url.as_str(), chat);
            let base_url = base_url(&config).unwrap();
            assert_eq!(url.origin(), base_url.origin());
            for path in ["api/version", "/api/show"] {
                let other = ollama_endpoint(&config, &prefix, path).unwrap();
                assert_eq!(other.origin(), base_url.origin());
                assert!(!other.path().contains("/api/api"), "{other}");
            }
        }
    }

    #[test]
    fn context_size_bounds_and_default() {
        let mut config = ollama("http://127.0.0.1:11434/v1");
        assert_eq!(requested_context_size(&config), DEFAULT_CONTEXT_SIZE);
        for size in [MIN_CONTEXT_SIZE, 16_384, MAX_CONTEXT_SIZE] {
            config.context_size = Some(size);
            assert!(validate_for_discovery(config.clone()).is_ok(), "{size}");
        }
        for size in [0, 2_047, MAX_CONTEXT_SIZE + 1, u32::MAX] {
            config.context_size = Some(size);
            assert_eq!(
                validate_for_discovery(config.clone()).unwrap_err(),
                CONTEXT_SIZE_INVALID,
                "{size}"
            );
        }
        // Other kinds never carry a context size.
        let mut cloud = provider(AiProviderKind::Openai, "https://api.openai.com");
        cloud.context_size = Some(1);
        assert_eq!(normalize_fields(cloud).context_size, None);
    }

    #[test]
    fn context_size_round_trips_and_is_optional_on_disk() {
        let json = r#"{"id":"o","kind":"ollama","label":"O","baseUrl":null,"host":null,"subPath":null,"defaultModel":"m","models":[],"apiKeyRef":null,"enabled":true,"isDefault":null}"#;
        let config: AiProviderConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.context_size, None);
        assert!(!serde_json::to_string(&config)
            .unwrap()
            .contains("contextSize"));
        let mut sized = config.clone();
        sized.context_size = Some(8192);
        let text = serde_json::to_string(&sized).unwrap();
        assert!(text.contains(r#""contextSize":8192"#));
        assert_eq!(
            serde_json::from_str::<AiProviderConfig>(&text).unwrap(),
            sized
        );
    }

    #[test]
    fn capabilities_per_kind() {
        assert_eq!(
            AiProviderKind::Openai.key_capability(),
            KeyCapability::Required
        );
        assert_eq!(AiProviderKind::Ollama.key_capability(), KeyCapability::None);
        assert_eq!(AiProviderKind::Ollama.class(), ProviderClass::Local);
        assert_eq!(AiProviderKind::Groq.class(), ProviderClass::Cloud);
    }

    #[test]
    fn local_defaults_match_server_conventions() {
        assert_eq!(
            AiProviderKind::Ollama.default_base_url(),
            "http://127.0.0.1:11434/v1"
        );
    }

    #[test]
    fn composes_base_url_from_host_and_sub_path() {
        let config = normalize_fields(provider(AiProviderKind::Openai, "https://api.openai.com/"));
        assert_eq!(
            config.base_url.as_deref(),
            Some("https://api.openai.com/v1")
        );
    }

    #[test]
    fn keeps_model_ids_exactly() {
        let mut config = provider(AiProviderKind::Ollama, "http://127.0.0.1:11434");
        config.default_model = "llama3:8b".into();
        config.models = vec![
            "llama3:8b".into(),
            " default ".into(),
            "local-model".into(),
            "qwen2.5-coder:7b-instruct-q4_K_M".into(),
            "llama3:8b".into(),
        ];
        let config = validate_for_completion(config).unwrap();
        assert_eq!(config.default_model, "llama3:8b");
        assert_eq!(
            config.models,
            vec![
                "llama3:8b",
                "default",
                "local-model",
                "qwen2.5-coder:7b-instruct-q4_K_M"
            ]
        );
    }

    #[test]
    fn discovery_does_not_require_a_model() {
        let mut config = provider(AiProviderKind::Ollama, "http://127.0.0.1:11434");
        config.id = String::new();
        config.label = String::new();
        config.default_model = String::new();
        config.models.clear();
        assert!(validate_for_discovery(config.clone()).is_ok());
        assert_eq!(
            validate_for_completion(config).unwrap_err(),
            "AI_PROVIDER_ID_REQUIRED"
        );
    }

    #[test]
    fn save_allows_missing_model_but_completion_does_not() {
        let mut config = provider(AiProviderKind::Ollama, "http://127.0.0.1:11434");
        config.default_model = String::new();
        config.models.clear();
        let saved = validate_for_save(config.clone()).unwrap();
        assert!(saved.models.is_empty());
        assert_eq!(
            validate_for_completion(config).unwrap_err(),
            "AI_PROVIDER_MODEL_REQUIRED"
        );
    }

    #[test]
    fn completion_requires_model() {
        let mut config = provider(AiProviderKind::Openai, "https://api.openai.com");
        config.default_model = " ".into();
        assert_eq!(
            validate_for_completion(config).unwrap_err(),
            "AI_PROVIDER_MODEL_REQUIRED"
        );
    }

    #[test]
    fn applies_url_policy_per_class() {
        let cloud_http = provider(AiProviderKind::Openai, "http://example.com");
        assert_eq!(
            validate_for_discovery(cloud_http).unwrap_err(),
            url_policy::HTTPS_REQUIRED
        );
        let mut saved_http = provider(AiProviderKind::Openai, "https://api.openai.com");
        saved_http.base_url = Some("http://evil.example/v1".into());
        assert_eq!(
            validate_for_discovery(saved_http).unwrap_err(),
            url_policy::HTTPS_REQUIRED
        );
        let local_public = provider(AiProviderKind::Ollama, "http://8.8.8.8:11434");
        assert_eq!(
            validate_for_discovery(local_public).unwrap_err(),
            url_policy::HOST_NOT_ALLOWED
        );
        let lan = provider(AiProviderKind::Ollama, "http://192.168.1.5:11434");
        assert!(validate_for_discovery(lan).is_ok());
    }

    #[test]
    fn endpoint_joins_and_revalidates() {
        let config = normalize_fields(provider(AiProviderKind::Ollama, "http://127.0.0.1:11434"));
        assert_eq!(
            endpoint(&config, "/models").unwrap().as_str(),
            "http://127.0.0.1:11434/v1/models"
        );
    }

    #[test]
    fn key_ref_is_derived_from_id() {
        assert_eq!(key_ref("openai-1"), "politedb:ai:openai-1:api_key");
    }

    #[test]
    fn reads_removed_openai_compatible_kind_as_ollama() {
        let json = r#"{"providers":[{"id":"lm","kind":"local_openai_compatible","label":"LM Studio","baseUrl":"http://127.0.0.1:1234/v1","host":null,"subPath":null,"defaultModel":"qwen","models":["qwen"],"apiKeyRef":null,"enabled":true,"isDefault":false}]}"#;
        let file: AiProviderFile = serde_json::from_str(json).unwrap();
        assert_eq!(file.providers[0].kind, AiProviderKind::Ollama);
        assert_eq!(
            file.providers[0].base_url.as_deref(),
            Some("http://127.0.0.1:1234/v1")
        );
        // New saves write the canonical kind.
        assert!(serde_json::to_string(&file)
            .unwrap()
            .contains(r#""kind":"ollama""#));
    }
}
