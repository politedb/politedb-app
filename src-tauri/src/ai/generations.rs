//! Per-provider configuration generations, shared by every cache that learns from
//! provider requests (plan ollama-native-context A6, C7).
//!
//! Saving or deleting a provider bumps its generation. A run reads the generation
//! together with the config under `ai_providers_lock`; a cache only stores a result
//! whose generation is still current.
//!
//! Lock order: a publisher takes the generations lock **first**, checks the generation,
//! then takes its own cache lock and inserts. Nothing takes a cache lock and then the
//! generations lock, so a bump can never fall between the check and the insert.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct ProviderGenerations {
    inner: Mutex<HashMap<String, u64>>,
}

impl ProviderGenerations {
    pub fn current(&self, provider_id: &str) -> u64 {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.get(provider_id).copied().unwrap_or(0)
    }

    /// The provider's config changed (saved or deleted).
    pub fn bump(&self, provider_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *inner.entry(provider_id.to_string()).or_insert(0) += 1;
    }

    /// Runs `publish` while holding the generations lock, only if `generation` is still
    /// current for `provider_id`. Returns whether it ran.
    pub fn publish_if_current(
        &self,
        provider_id: &str,
        generation: u64,
        publish: impl FnOnce(),
    ) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.get(provider_id).copied().unwrap_or(0) != generation {
            return false;
        }
        publish();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn stale_generations_never_publish() {
        let gens = ProviderGenerations::default();
        let start = gens.current("p");
        gens.bump("p");
        let mut ran = false;
        assert!(!gens.publish_if_current("p", start, || ran = true));
        assert!(!ran);
        assert!(gens.publish_if_current("p", gens.current("p"), || ran = true));
        assert!(ran);
        assert_eq!(gens.current("other"), 0);
    }

    #[test]
    fn a_bump_cannot_fall_between_check_and_insert() {
        let gens = Arc::new(ProviderGenerations::default());
        let stored = Arc::new(Mutex::new(None::<u64>));
        let barrier = Arc::new(Barrier::new(2));
        let generation = gens.current("p");
        let publisher = {
            let (gens, stored, barrier) = (gens.clone(), stored.clone(), barrier.clone());
            std::thread::spawn(move || {
                gens.publish_if_current("p", generation, || {
                    // The bump below must wait until this insert completes.
                    barrier.wait();
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    *stored.lock().unwrap() = Some(generation);
                })
            })
        };
        barrier.wait();
        gens.bump("p");
        assert!(publisher.join().unwrap());
        // The publish completed before the bump; the next reader sees a newer generation
        // and treats the stored value as stale.
        assert_eq!(*stored.lock().unwrap(), Some(generation));
        assert_eq!(gens.current("p"), generation + 1);
    }
}
