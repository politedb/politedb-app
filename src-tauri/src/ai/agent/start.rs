//! What a run needs from the provider store, read consistently (plan ai-agent R1/R2).

use std::sync::Mutex;

use super::model::{CapabilityCache, CapabilityKey};
use crate::ai::provider::AiProviderConfig;
use crate::ai::provider_store::{self, ProviderFilePort, SecretPort};

pub struct RunSnapshot {
    pub config: AiProviderConfig,
    pub key: Option<String>,
    pub model_id: String,
    pub capability_key: CapabilityKey,
}

/// Reads the provider config, its key, the model to use and the capability-cache
/// generation under `providers_lock` — the lock provider save/delete hold while they
/// bump that generation — so all four describe one configuration. A save cannot slip
/// between reading the config and reading the generation. The lock is released before
/// the caller does any network I/O.
pub fn snapshot_for_run(
    providers_lock: &Mutex<()>,
    files: &impl ProviderFilePort,
    secrets: &impl SecretPort,
    capabilities: &CapabilityCache,
    provider_id: &str,
    model: Option<&str>,
) -> Result<RunSnapshot, String> {
    let _guard = providers_lock
        .lock()
        .map_err(|_| "AI_PROVIDER_LOCK_FAILED".to_string())?;
    let (config, key) = provider_store::snapshot_for_chat(files, secrets, provider_id)?;
    let model_id = model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(&config.default_model)
        .to_string();
    if model_id.is_empty() {
        return Err("AI_PROVIDER_MODEL_REQUIRED".into());
    }
    let capability_key = capabilities.key(&config, &model_id);
    Ok(RunSnapshot {
        config,
        key,
        model_id,
        capability_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{tests::provider, AiProviderFile, AiProviderKind};
    use std::sync::Barrier;

    struct SharedFiles(Mutex<AiProviderFile>);

    impl ProviderFilePort for SharedFiles {
        fn load(&self) -> Result<AiProviderFile, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, file: &AiProviderFile) -> Result<(), String> {
            *self.0.lock().unwrap() = file.clone();
            Ok(())
        }
    }

    struct Keys;

    impl SecretPort for Keys {
        fn get(&self, _key: &str) -> Result<Option<String>, String> {
            Ok(Some("k".into()))
        }
        fn set(&self, _key: &str, _value: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self, _key: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn config(sub_path: &str) -> AiProviderConfig {
        let mut config = provider(AiProviderKind::Openai, "https://api.example.com");
        config.sub_path = Some(sub_path.into());
        config
    }

    /// A save that holds the provider lock while a run starts: the run sees either the
    /// old config with the old generation or the new config with the new generation,
    /// never the old config with the new generation.
    #[test]
    fn a_concurrent_save_never_pairs_an_old_config_with_a_new_generation() {
        let lock = Mutex::new(());
        let files = SharedFiles(Mutex::new(AiProviderFile {
            providers: vec![config("/v1")],
        }));
        let cache = CapabilityCache::default();
        let saving = Barrier::new(2);

        let snapshot = std::thread::scope(|scope| {
            scope.spawn(|| {
                let _guard = lock.lock().unwrap();
                saving.wait(); // the run is now about to start
                std::thread::sleep(std::time::Duration::from_millis(30));
                files
                    .save(&AiProviderFile {
                        providers: vec![config("/v2")],
                    })
                    .unwrap();
                cache.forget_provider("p1");
            });
            saving.wait();
            snapshot_for_run(&lock, &files, &Keys, &cache, "p1", None).unwrap()
        });

        assert_eq!(snapshot.config.sub_path.as_deref(), Some("/v2"));
        // Its key is the current one, so what this run learns is about the new config.
        cache.record(snapshot.capability_key.clone(), false);
        let current = cache.key(&snapshot.config, &snapshot.model_id);
        assert_eq!(cache.get(&current), Some(false));
        assert_eq!(snapshot.model_id, "model-a");
        assert_eq!(snapshot.key.as_deref(), Some("k"));
    }

    #[test]
    fn an_explicit_model_wins_and_blank_falls_back() {
        let lock = Mutex::new(());
        let files = SharedFiles(Mutex::new(AiProviderFile {
            providers: vec![config("/v1")],
        }));
        let cache = CapabilityCache::default();
        let pick = |model| {
            snapshot_for_run(&lock, &files, &Keys, &cache, "p1", model)
                .unwrap()
                .model_id
        };
        assert_eq!(pick(Some("gpt-5")), "gpt-5");
        assert_eq!(pick(Some("  ")), "model-a");
    }
}
