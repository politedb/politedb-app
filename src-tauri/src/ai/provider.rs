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
}

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

/// Validation for model discovery: URL only, no model required (R12).
pub fn validate_for_discovery(config: AiProviderConfig) -> Result<AiProviderConfig, String> {
    let config = normalize_fields(config);
    base_url(&config)?;
    Ok(config)
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
        }
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
