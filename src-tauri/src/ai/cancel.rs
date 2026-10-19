//! Request-scoped cancellation for model discovery and server status (plan R10,
//! plan ollama-native-context Revision 6 D1).
//!
//! Each request has a caller-chosen request id, so one dialog can never cancel another's
//! request. A cancel that arrives before the request registered is remembered and fires
//! as soon as it registers. Every registration gets a token: only the registration that
//! owns the current entry can finish it, so a late cleanup never removes a newer
//! request that reused the id.

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
    active: HashMap<String, (u64, oneshot::Sender<()>)>,
    early: HashSet<String>,
    next_token: u64,
}

/// One registration: its cancel signal and the token that finishes it.
pub struct Registration {
    pub token: u64,
    pub rx: oneshot::Receiver<()>,
}

impl CancelRegistry {
    /// Registers `id` and returns its cancel signal, already fired if the id was
    /// cancelled before registering. Reusing an active id supersedes the older
    /// request: its signal fires and it no longer owns the entry.
    pub fn register(&self, id: &str) -> Registration {
        let (tx, rx) = oneshot::channel();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.next_token += 1;
        let token = inner.next_token;
        if inner.early.remove(id) {
            let _ = tx.send(());
        } else if let Some((_, previous)) = inner.active.insert(id.to_string(), (token, tx)) {
            let _ = previous.send(());
        }
        Registration { token, rx }
    }

    pub fn cancel(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.active.remove(id) {
            Some((_, tx)) => {
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

    #[cfg(test)]
    pub fn active_len(&self) -> usize {
        self.inner.lock().unwrap().active.len()
    }

    /// Forgets `id` once the registration holding `token` finished. Does nothing when a
    /// newer registration owns the id, or when it was already cancelled.
    pub fn finish(&self, id: &str, token: u64) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner
            .active
            .get(id)
            .is_some_and(|(owner, _)| *owner == token)
        {
            inner.active.remove(id);
        }
    }
}

/// Runs `work` as request `id`: registered before it starts, raced against a cancel
/// for that id (cancel wins ties, returning `canceled`), and finished on every exit.
/// Used by model discovery and the Ollama status request.
pub async fn run_cancellable<T>(
    registry: &CancelRegistry,
    id: &str,
    canceled: &str,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let registration = registry.register(id);
    let _finish = FinishGuard::new(registry, id, registration.token);
    tokio::select! {
        biased;
        _ = registration.rx => Err(canceled.to_string()),
        result = work => result,
    }
}

/// Finishes a registration when dropped, on every exit path.
pub struct FinishGuard<'a> {
    registry: &'a CancelRegistry,
    id: String,
    token: u64,
}

impl<'a> FinishGuard<'a> {
    pub fn new(registry: &'a CancelRegistry, id: &str, token: u64) -> Self {
        Self {
            registry,
            id: id.to_string(),
            token,
        }
    }
}

impl Drop for FinishGuard<'_> {
    fn drop(&mut self) {
        self.registry.finish(&self.id, self.token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(registry: &CancelRegistry) -> usize {
        registry.inner.lock().unwrap().active.len()
    }

    #[test]
    fn cancels_only_the_named_request() {
        let registry = CancelRegistry::default();
        let mut a = registry.register("dialog-a:1");
        let mut b = registry.register("dialog-b:1");
        registry.cancel("dialog-a:1");
        assert!(a.rx.try_recv().is_ok());
        assert!(
            b.rx.try_recv().is_err(),
            "other dialog's request must keep running"
        );
    }

    #[test]
    fn cancel_before_registration_is_not_lost() {
        let registry = CancelRegistry::default();
        registry.cancel("req-1");
        let mut rx = registry.register("req-1").rx;
        assert!(rx.try_recv().is_ok());
        // The early cancel is consumed: a later reuse of the id starts clean.
        let mut again = registry.register("req-1").rx;
        assert!(again.try_recv().is_err());
    }

    #[test]
    fn finished_requests_are_forgotten() {
        let registry = CancelRegistry::default();
        let mut reg = registry.register("req-2");
        registry.finish("req-2", reg.token);
        assert!(reg.rx.try_recv().is_err());
        assert_eq!(active(&registry), 0);
    }

    #[test]
    fn reuse_supersedes_and_the_old_cleanup_keeps_the_successor() {
        let registry = CancelRegistry::default();
        let mut a = registry.register("x");
        let mut b = registry.register("x");
        assert!(a.rx.try_recv().is_ok(), "the older request is superseded");
        // A's guard runs late: B still owns the id and keeps running.
        registry.finish("x", a.token);
        assert_eq!(active(&registry), 1);
        assert!(b.rx.try_recv().is_err());
        registry.finish("x", b.token);
        assert_eq!(active(&registry), 0);
    }

    #[test]
    fn cancel_then_reregister_before_old_cleanup_keeps_the_new_one() {
        let registry = CancelRegistry::default();
        let mut a = registry.register("x");
        registry.cancel("x");
        assert!(a.rx.try_recv().is_ok());
        let mut b = registry.register("x");
        // A unwinds after B registered.
        registry.finish("x", a.token);
        assert!(b.rx.try_recv().is_err(), "B was never cancelled");
        assert_eq!(active(&registry), 1);
        registry.cancel("x");
        assert!(b.rx.try_recv().is_ok());
    }

    #[test]
    fn guard_finishes_on_every_exit() {
        let registry = CancelRegistry::default();
        {
            let reg = registry.register("g");
            let _guard = FinishGuard::new(&registry, "g", reg.token);
        }
        assert_eq!(active(&registry), 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let reg = registry.register("p");
            let _guard = FinishGuard::new(&registry, "p", reg.token);
            panic!("boom");
        }));
        assert!(result.is_err());
        assert_eq!(active(&registry), 0);
    }

    #[test]
    fn concurrent_registrations_leave_one_owner() {
        let registry = std::sync::Arc::new(CancelRegistry::default());
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                std::thread::spawn(move || registry.register("same").token)
            })
            .collect();
        let tokens: Vec<u64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(active(&registry), 1);
        let mut unique = tokens.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), tokens.len(), "tokens are unique");
    }

    #[tokio::test]
    async fn cancel_interrupts_a_request_in_flight() {
        let registry = std::sync::Arc::new(CancelRegistry::default());
        let rx = registry.register("req-3").rx;
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
