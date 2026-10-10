//! Provider file + API key persistence as one transaction (plan R4, R11, R13).
//!
//! Callers hold the provider lock (`AppState::ai_providers_lock`) around every call here,
//! and never perform network I/O while holding it.

use super::provider::{
    self, key_ref, validate_for_save, AiProviderConfig, AiProviderFile, KeyCapability,
};

pub const ROLLBACK_FAILED: &str = "AI_PROVIDER_SAVE_ROLLBACK_FAILED";

/// Keychain access. `get` returns `Ok(None)` only when the item is absent; `delete` treats
/// an absent item as success. Locked/denied/entitlement failures are errors.
pub trait SecretPort {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// `providers.json` access. `save` must leave the previous file intact on failure.
pub trait ProviderFilePort {
    fn load(&self) -> Result<AiProviderFile, String>;
    fn save(&self, file: &AiProviderFile) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyChange {
    /// Blank input: keep whatever key is stored.
    Keep,
    Set(String),
    Remove,
}

/// Validates and saves `config`, then applies `key_change`. If the key operation fails,
/// the previous file is restored; if that restore also fails, returns [`ROLLBACK_FAILED`].
pub fn save(
    files: &impl ProviderFilePort,
    secrets: &impl SecretPort,
    config: AiProviderConfig,
    key_change: KeyChange,
) -> Result<AiProviderConfig, String> {
    let mut config = validate_for_save(config)?;
    let previous_file = files.load()?;
    let reference = key_ref(&config.id);

    let key_change = match (config.kind.key_capability(), key_change) {
        (_, KeyChange::Set(value)) if value.trim().is_empty() => KeyChange::Keep,
        (KeyCapability::None, KeyChange::Set(_)) => {
            return Err("AI_PROVIDER_API_KEY_NOT_SUPPORTED".into())
        }
        // Keyless kinds never keep a key; switching a provider to one deletes it.
        (KeyCapability::None, _) => KeyChange::Remove,
        (KeyCapability::Required, KeyChange::Remove) => {
            return Err("AI_PROVIDER_API_KEY_REQUIRED".into())
        }
        (_, change) => change,
    };

    let has_key_after = match &key_change {
        KeyChange::Set(_) => true,
        KeyChange::Remove => false,
        KeyChange::Keep => secrets.get(&reference)?.is_some(),
    };
    if config.kind.key_capability() == KeyCapability::Required && !has_key_after {
        return Err("AI_PROVIDER_API_KEY_REQUIRED".into());
    }
    config.api_key_ref = has_key_after.then(|| reference.clone());

    let mut next_file = previous_file.clone();
    if config.is_default == Some(true) {
        for item in &mut next_file.providers {
            item.is_default = Some(false);
        }
    }
    match next_file.providers.iter().position(|p| p.id == config.id) {
        Some(index) => next_file.providers[index] = config.clone(),
        None => next_file.providers.push(config.clone()),
    }
    files.save(&next_file)?;

    let key_result = match &key_change {
        KeyChange::Keep => Ok(()),
        KeyChange::Set(value) => secrets.set(&reference, value.trim()),
        KeyChange::Remove => secrets.delete(&reference),
    };
    if let Err(error) = key_result {
        return match files.save(&previous_file) {
            Ok(()) => Err(error),
            Err(_) => Err(ROLLBACK_FAILED.into()),
        };
    }
    Ok(config)
}

/// Removes the provider, then its key. A missing provider is not an error.
pub fn delete(
    files: &impl ProviderFilePort,
    secrets: &impl SecretPort,
    provider_id: &str,
) -> Result<(), String> {
    let mut file = files.load()?;
    let before = file.providers.len();
    file.providers.retain(|p| p.id != provider_id);
    if file.providers.len() != before {
        files.save(&file)?;
    }
    secrets
        .delete(&key_ref(provider_id))
        .map_err(|_| "AI_PROVIDER_KEY_DELETE_FAILED".to_string())
}

/// API key to send for `config`. `auth` follows the draft form: `Keep` uses the stored
/// key, `Set` the typed one (nothing is persisted here). Keyed kinds must end up with a
/// key, keyless kinds never read the keychain, and only a genuinely absent item means
/// "no key"; locked/denied keychain errors fail.
pub fn request_key(
    secrets: &impl SecretPort,
    config: &AiProviderConfig,
    auth: &KeyChange,
) -> Result<Option<String>, String> {
    if config.kind.key_capability() == KeyCapability::None {
        return Ok(None);
    }
    match auth {
        KeyChange::Set(value) if !value.trim().is_empty() => Ok(Some(value.trim().to_string())),
        KeyChange::Remove => Err("AI_PROVIDER_API_KEY_MISSING".into()),
        _ => secrets
            .get(&key_ref(&config.id))
            .map_err(|_| "AI_PROVIDER_KEYCHAIN_FAILED".to_string())?
            .map(Some)
            .ok_or_else(|| "AI_PROVIDER_API_KEY_MISSING".to_string()),
    }
}

/// Enabled provider config plus its key, read together. Callers hold the provider lock
/// so a concurrent save (config then key, with rollback) is never observed half-done.
pub fn snapshot_for_chat(
    files: &impl ProviderFilePort,
    secrets: &impl SecretPort,
    provider_id: &str,
) -> Result<(AiProviderConfig, Option<String>), String> {
    let config = find(files, provider_id)?;
    if !config.enabled {
        return Err("AI_PROVIDER_DISABLED".into());
    }
    let key = request_key(secrets, &config, &KeyChange::Keep)?;
    Ok((config, key))
}

pub fn find(files: &impl ProviderFilePort, provider_id: &str) -> Result<AiProviderConfig, String> {
    files
        .load()?
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .map(provider::normalize_fields)
        .ok_or_else(|| "AI_PROVIDER_NOT_FOUND".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::tests::provider;
    use crate::ai::provider::AiProviderKind;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeFiles {
        file: RefCell<AiProviderFile>,
        fail_saves_from: RefCell<Option<usize>>,
        saves: RefCell<usize>,
    }

    impl ProviderFilePort for FakeFiles {
        fn load(&self) -> Result<AiProviderFile, String> {
            Ok(self.file.borrow().clone())
        }
        fn save(&self, file: &AiProviderFile) -> Result<(), String> {
            let n = *self.saves.borrow();
            *self.saves.borrow_mut() += 1;
            if self.fail_saves_from.borrow().is_some_and(|from| n >= from) {
                return Err("WRITE_FAILED".into());
            }
            *self.file.borrow_mut() = file.clone();
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeSecrets {
        items: RefCell<HashMap<String, String>>,
        fail_get: bool,
        fail_set: bool,
        fail_delete: bool,
    }

    impl SecretPort for FakeSecrets {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            if self.fail_get {
                return Err("KEYCHAIN_LOCKED".into());
            }
            Ok(self.items.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if self.fail_set {
                return Err("KEYCHAIN_DENIED".into());
            }
            self.items.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            if self.fail_delete {
                return Err("KEYCHAIN_DENIED".into());
            }
            self.items.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn ollama() -> AiProviderConfig {
        provider(AiProviderKind::Ollama, "http://127.0.0.1:11434")
    }

    fn cloud() -> AiProviderConfig {
        provider(AiProviderKind::Openai, "https://api.openai.com")
    }

    #[test]
    fn saves_cloud_key_and_ref() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        let saved = save(&files, &secrets, cloud(), KeyChange::Set(" sk-1 ".into())).unwrap();
        assert_eq!(saved.api_key_ref.as_deref(), Some("politedb:ai:p1:api_key"));
        assert_eq!(
            secrets
                .items
                .borrow()
                .get("politedb:ai:p1:api_key")
                .map(String::as_str),
            Some("sk-1")
        );
    }

    #[test]
    fn keyless_kind_has_no_ref() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        let saved = save(&files, &secrets, ollama(), KeyChange::Keep).unwrap();
        assert_eq!(saved.api_key_ref, None);
    }

    #[test]
    fn blank_key_input_keeps_existing_key() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        save(&files, &secrets, cloud(), KeyChange::Set("sk-1".into())).unwrap();
        let saved = save(&files, &secrets, cloud(), KeyChange::Set("  ".into())).unwrap();
        assert!(saved.api_key_ref.is_some());
        assert_eq!(
            secrets
                .items
                .borrow()
                .get("politedb:ai:p1:api_key")
                .map(String::as_str),
            Some("sk-1")
        );
    }

    #[test]
    fn cloud_requires_a_key() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        assert_eq!(
            save(&files, &secrets, cloud(), KeyChange::Keep).unwrap_err(),
            "AI_PROVIDER_API_KEY_REQUIRED"
        );
        assert_eq!(
            save(&files, &secrets, cloud(), KeyChange::Remove).unwrap_err(),
            "AI_PROVIDER_API_KEY_REQUIRED"
        );
        assert!(files.file.borrow().providers.is_empty());
    }

    #[test]
    fn ollama_rejects_keys_and_kind_change_deletes_stored_key() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        save(&files, &secrets, cloud(), KeyChange::Set("sk-1".into())).unwrap();
        let mut switched = cloud();
        switched.kind = AiProviderKind::Ollama;
        switched.host = Some("http://127.0.0.1:11434".into());
        assert_eq!(
            save(
                &files,
                &secrets,
                switched.clone(),
                KeyChange::Set("x".into())
            )
            .unwrap_err(),
            "AI_PROVIDER_API_KEY_NOT_SUPPORTED"
        );
        let saved = save(&files, &secrets, switched, KeyChange::Keep).unwrap();
        assert_eq!(saved.api_key_ref, None);
        assert!(secrets.items.borrow().is_empty());
    }

    #[test]
    fn key_write_failure_restores_previous_config() {
        let files = FakeFiles::default();
        let ok = FakeSecrets::default();
        save(&files, &ok, cloud(), KeyChange::Set("sk-1".into())).unwrap();
        let before = files.file.borrow().clone();

        let failing = FakeSecrets {
            fail_set: true,
            items: RefCell::new(ok.items.borrow().clone()),
            ..Default::default()
        };
        let mut edited = cloud();
        edited.label = "Edited".into();
        assert_eq!(
            save(&files, &failing, edited, KeyChange::Set("sk-2".into())).unwrap_err(),
            "KEYCHAIN_DENIED"
        );
        assert_eq!(*files.file.borrow(), before);
    }

    #[test]
    fn key_delete_failure_on_kind_change_restores_previous_config() {
        let files = FakeFiles::default();
        let secrets = FakeSecrets::default();
        save(&files, &secrets, cloud(), KeyChange::Set("sk-1".into())).unwrap();
        let before = files.file.borrow().clone();
        let failing = FakeSecrets {
            fail_delete: true,
            items: RefCell::new(secrets.items.borrow().clone()),
            ..Default::default()
        };
        let mut switched = cloud();
        switched.kind = AiProviderKind::Ollama;
        switched.host = Some("http://127.0.0.1:11434".into());
        assert!(save(&files, &failing, switched, KeyChange::Keep).is_err());
        assert_eq!(*files.file.borrow(), before);
    }

    #[test]
    fn rollback_failure_is_reported() {
        let files = FakeFiles::default();
        *files.fail_saves_from.borrow_mut() = Some(1);
        let failing = FakeSecrets {
            fail_set: true,
            ..Default::default()
        };
        assert_eq!(
            save(&files, &failing, cloud(), KeyChange::Set("sk-1".into())).unwrap_err(),
            ROLLBACK_FAILED
        );
    }

    #[test]
    fn keychain_read_errors_are_not_treated_as_missing() {
        let (files, secrets) = (
            FakeFiles::default(),
            FakeSecrets {
                fail_get: true,
                ..Default::default()
            },
        );
        assert!(save(&files, &secrets, cloud(), KeyChange::Keep).is_err());
        assert_eq!(
            request_key(&secrets, &cloud(), &KeyChange::Keep).unwrap_err(),
            "AI_PROVIDER_KEYCHAIN_FAILED"
        );
    }

    #[test]
    fn request_key_semantics_per_kind() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        let keep = KeyChange::Keep;
        assert_eq!(
            request_key(&secrets, &cloud(), &keep).unwrap_err(),
            "AI_PROVIDER_API_KEY_MISSING"
        );
        save(&files, &secrets, cloud(), KeyChange::Set("stored".into())).unwrap();
        assert_eq!(
            request_key(&secrets, &cloud(), &keep).unwrap().as_deref(),
            Some("stored")
        );
        let typed = KeyChange::Set(" draft ".into());
        assert_eq!(
            request_key(&secrets, &cloud(), &typed).unwrap().as_deref(),
            Some("draft")
        );
        assert_eq!(
            request_key(&secrets, &cloud(), &KeyChange::Remove).unwrap_err(),
            "AI_PROVIDER_API_KEY_MISSING"
        );
        // Keyless kinds never read the keychain and ignore typed keys.
        assert_eq!(request_key(&secrets, &ollama(), &typed).unwrap(), None);
        assert_eq!(request_key(&secrets, &ollama(), &keep).unwrap(), None);
    }

    #[test]
    fn saves_without_a_model_for_offline_setup() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        let mut draft = ollama();
        draft.default_model = String::new();
        draft.models.clear();
        draft.enabled = false;
        let saved = save(&files, &secrets, draft, KeyChange::Keep).unwrap();
        assert!(!saved.enabled);
        assert!(saved.models.is_empty());
        assert_eq!(files.file.borrow().providers.len(), 1);
    }

    #[test]
    fn chat_snapshot_requires_enabled_provider() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        let mut off = cloud();
        off.enabled = false;
        save(&files, &secrets, off, KeyChange::Set("tok".into())).unwrap();
        assert_eq!(
            snapshot_for_chat(&files, &secrets, "p1").unwrap_err(),
            "AI_PROVIDER_DISABLED"
        );
        save(&files, &secrets, cloud(), KeyChange::Keep).unwrap();
        let (config, key) = snapshot_for_chat(&files, &secrets, "p1").unwrap();
        assert!(config.enabled);
        assert_eq!(key.as_deref(), Some("tok"));
    }

    #[test]
    fn default_flag_is_exclusive() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        let mut first = ollama();
        first.is_default = Some(true);
        save(&files, &secrets, first, KeyChange::Keep).unwrap();
        let mut second = ollama();
        second.id = "p2".into();
        second.is_default = Some(true);
        save(&files, &secrets, second, KeyChange::Keep).unwrap();
        let file = files.file.borrow();
        assert_eq!(file.providers[0].is_default, Some(false));
        assert_eq!(file.providers[1].is_default, Some(true));
    }

    #[test]
    fn delete_removes_provider_and_key() {
        let (files, secrets) = (FakeFiles::default(), FakeSecrets::default());
        save(&files, &secrets, cloud(), KeyChange::Set("tok".into())).unwrap();
        delete(&files, &secrets, "p1").unwrap();
        assert!(files.file.borrow().providers.is_empty());
        assert!(secrets.items.borrow().is_empty());
    }

    mod concurrency {
        use super::super::*;
        use crate::ai::provider::tests::provider;
        use crate::ai::provider::AiProviderKind;
        use std::collections::HashMap;
        use std::sync::{mpsc, Arc, Mutex};
        use std::thread;
        use std::time::Duration;

        #[derive(Default)]
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

        /// Pauses inside `set` (after the config was written) until released; can then fail.
        struct PausingSecrets {
            items: Mutex<HashMap<String, String>>,
            reached_set: Mutex<Option<mpsc::Sender<()>>>,
            release: Mutex<Option<mpsc::Receiver<()>>>,
            fail_set: bool,
        }

        impl SecretPort for PausingSecrets {
            fn get(&self, key: &str) -> Result<Option<String>, String> {
                Ok(self.items.lock().unwrap().get(key).cloned())
            }
            fn set(&self, key: &str, value: &str) -> Result<(), String> {
                if let Some(tx) = self.reached_set.lock().unwrap().take() {
                    tx.send(()).unwrap();
                    self.release.lock().unwrap().take().unwrap().recv().unwrap();
                }
                if self.fail_set {
                    return Err("KEYCHAIN_DENIED".into());
                }
                self.items.lock().unwrap().insert(key.into(), value.into());
                Ok(())
            }
            fn delete(&self, key: &str) -> Result<(), String> {
                self.items.lock().unwrap().remove(key);
                Ok(())
            }
        }

        #[test]
        fn chat_snapshot_never_sees_new_host_with_old_key() {
            let files = Arc::new(SharedFiles::default());
            let (reached_tx, reached_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let secrets = Arc::new(PausingSecrets {
                items: Mutex::new(HashMap::new()),
                reached_set: Mutex::new(None),
                release: Mutex::new(None),
                fail_set: false,
            });
            let lock = Arc::new(Mutex::new(()));

            let mut original = provider(AiProviderKind::Openai, "https://api.openai.com");
            original.id = "cloud".into();
            save(
                &*files,
                &*secrets,
                original.clone(),
                KeyChange::Set("old-key".into()),
            )
            .unwrap();

            *secrets.reached_set.lock().unwrap() = Some(reached_tx);
            *secrets.release.lock().unwrap() = Some(release_rx);
            let mut moved = original.clone();
            moved.host = Some("https://other-host.example".into());

            let writer = {
                let (files, secrets, lock) = (files.clone(), secrets.clone(), lock.clone());
                thread::spawn(move || {
                    let _guard = lock.lock().unwrap();
                    save(&*files, &*secrets, moved, KeyChange::Set("new-key".into())).unwrap();
                })
            };
            // Writer has replaced the config and is paused before writing the key.
            reached_rx.recv().unwrap();

            let reader = {
                let (files, secrets, lock) = (files.clone(), secrets.clone(), lock.clone());
                thread::spawn(move || {
                    let _guard = lock.lock().unwrap();
                    snapshot_for_chat(&*files, &*secrets, "cloud").unwrap()
                })
            };
            thread::sleep(Duration::from_millis(50));
            assert!(
                !reader.is_finished(),
                "reader must wait for the save to finish"
            );
            release_tx.send(()).unwrap();
            writer.join().unwrap();
            let (config, key) = reader.join().unwrap();
            assert_eq!(
                config.base_url.as_deref(),
                Some("https://other-host.example/v1")
            );
            assert_eq!(key.as_deref(), Some("new-key"));
        }

        #[test]
        fn list_never_sees_config_of_a_save_that_rolls_back() {
            let files = Arc::new(SharedFiles::default());
            let lock = Arc::new(Mutex::new(()));
            let mut original = provider(AiProviderKind::Openai, "https://api.openai.com");
            original.id = "cloud-1".into();
            {
                let ok = PausingSecrets {
                    items: Mutex::new(HashMap::new()),
                    reached_set: Mutex::new(None),
                    release: Mutex::new(None),
                    fail_set: false,
                };
                save(
                    &*files,
                    &ok,
                    original.clone(),
                    KeyChange::Set("sk-0".into()),
                )
                .unwrap();
            }

            let (reached_tx, reached_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let failing = Arc::new(PausingSecrets {
                items: Mutex::new(HashMap::new()),
                reached_set: Mutex::new(Some(reached_tx)),
                release: Mutex::new(Some(release_rx)),
                fail_set: true,
            });
            let mut moved = original.clone();
            moved.host = Some("https://other-host.example".into());

            let writer = {
                let (files, failing, lock) = (files.clone(), failing.clone(), lock.clone());
                thread::spawn(move || {
                    let _guard = lock.lock().unwrap();
                    save(&*files, &*failing, moved, KeyChange::Set("tok".into()))
                })
            };
            reached_rx.recv().unwrap();

            let reader = {
                let (files, lock) = (files.clone(), lock.clone());
                thread::spawn(move || {
                    let _guard = lock.lock().unwrap();
                    files.load().unwrap()
                })
            };
            thread::sleep(Duration::from_millis(50));
            assert!(
                !reader.is_finished(),
                "list must wait for the save to finish"
            );
            release_tx.send(()).unwrap();
            assert_eq!(writer.join().unwrap().unwrap_err(), "KEYCHAIN_DENIED");
            let listed = reader.join().unwrap();
            assert_eq!(
                listed.providers[0].host.as_deref(),
                Some("https://api.openai.com"),
                "rolled-back config must never be listed"
            );
        }
    }
}
