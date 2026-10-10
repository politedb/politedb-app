//! Request-scoped cancellation for model discovery (plan R10).
//!
//! Each discovery has a caller-chosen request id, so one dialog can never cancel another's
//! request. A cancel that arrives before the request registered is remembered and fires
//! as soon as it registers.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tokio::sync::oneshot;

/// Upper bound on remembered early cancels (ids that never registered).
const MAX_EARLY_CANCELS: usize = 256;

#[derive(Default)]
pub struct CancelRegistry {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    active: HashMap<String, oneshot::Sender<()>>,
    early: HashSet<String>,
}

impl CancelRegistry {
    /// Registers `id` and returns its cancel signal. Already fired if the id was
    /// cancelled before registering.
    pub fn register(&self, id: &str) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.early.remove(id) {
            let _ = tx.send(());
        } else if let Some(previous) = inner.active.insert(id.to_string(), tx) {
            // Same id reused: the older request is superseded.
            let _ = previous.send(());
        }
        rx
    }

    pub fn cancel(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.active.remove(id) {
            Some(tx) => {
                let _ = tx.send(());
            }
            None => {
                if inner.early.len() >= MAX_EARLY_CANCELS {
                    inner.early.clear();
                }
                inner.early.insert(id.to_string());
            }
        }
    }

    /// Forgets `id` once its request finished (no-op if already cancelled).
    pub fn finish(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.active.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancels_only_the_named_request() {
        let registry = CancelRegistry::default();
        let mut a = registry.register("dialog-a:1");
        let mut b = registry.register("dialog-b:1");
        registry.cancel("dialog-a:1");
        assert!(a.try_recv().is_ok());
        assert!(
            b.try_recv().is_err(),
            "other dialog's request must keep running"
        );
    }

    #[test]
    fn cancel_before_registration_is_not_lost() {
        let registry = CancelRegistry::default();
        registry.cancel("req-1");
        let mut rx = registry.register("req-1");
        assert!(rx.try_recv().is_ok());
        // The early cancel is consumed: a later reuse of the id starts clean.
        let mut again = registry.register("req-1");
        assert!(again.try_recv().is_err());
    }

    #[test]
    fn finished_requests_are_forgotten() {
        let registry = CancelRegistry::default();
        let mut rx = registry.register("req-2");
        registry.finish("req-2");
        assert!(rx.try_recv().is_err());
        assert!(registry.inner.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn cancel_interrupts_a_request_in_flight() {
        let registry = std::sync::Arc::new(CancelRegistry::default());
        let rx = registry.register("req-3");
        let canceller = registry.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            canceller.cancel("req-3");
        });
        let outcome = tokio::select! {
            _ = rx => "cancelled",
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => "finished",
        };
        assert_eq!(outcome, "cancelled");
    }
}
