//! Active access to a granted resource, stopped exactly once on drop.

use super::port::{PortError, ScopedResource};

/// Keeps a security-scoped resource accessible. Hold it for as long as native code
/// may touch the file (for databases: until the connection is closed).
pub struct Lease {
    resource: Box<dyn ScopedResource>,
}

impl Lease {
    /// Wraps a resource whose `start` already returned `true`.
    pub(super) fn started(resource: Box<dyn ScopedResource>) -> Self {
        Self { resource }
    }

    pub(super) fn stale(&self) -> bool {
        self.resource.stale()
    }

    /// Fresh bookmark data, created while access is active.
    pub(super) fn bookmark(&self, read_only: bool) -> Result<Vec<u8>, PortError> {
        self.resource.bookmark(read_only)
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.resource.stop();
    }
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the path.
        f.write_str("Lease")
    }
}

/// A value that must be dropped before the lease that makes it usable, e.g. a database
/// connection: fields drop in declaration order, so the connection closes (checkpoint,
/// WAL cleanup) while access is still active.
pub struct Leased<T> {
    inner: T,
    _lease: Option<Lease>,
}

impl<T> Leased<T> {
    pub fn new(inner: T, lease: Option<Lease>) -> Self {
        Self {
            inner,
            _lease: lease,
        }
    }
}

impl<T> std::ops::Deref for Leased<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::port::{BookmarkPort, PortError};
    use crate::file_access::test_support::FakePort;
    use std::sync::{Arc, Mutex};

    /// Records when the wrapped value is dropped relative to `stop`.
    struct Closes {
        log: Arc<Mutex<Vec<&'static str>>>,
    }
    impl Drop for Closes {
        fn drop(&mut self) {
            self.log.lock().unwrap().push("close");
        }
    }

    struct LoggedResource {
        log: Arc<Mutex<Vec<&'static str>>>,
    }
    impl ScopedResource for LoggedResource {
        fn path(&self) -> std::path::PathBuf {
            "/x".into()
        }
        fn stale(&self) -> bool {
            false
        }
        fn start(&self) -> bool {
            true
        }
        fn stop(&self) {
            self.log.lock().unwrap().push("stop");
        }
        fn bookmark(&self, _: bool) -> Result<Vec<u8>, PortError> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn connection_closes_before_access_stops() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let lease = Lease::started(Box::new(LoggedResource { log: log.clone() }));
        let shared = Arc::new(Leased::new(Closes { log: log.clone() }, Some(lease)));
        // A background task still holding a clone keeps access alive.
        let task_clone = shared.clone();
        drop(shared);
        assert!(log.lock().unwrap().is_empty());
        drop(task_clone);
        assert_eq!(*log.lock().unwrap(), vec!["close", "stop"]);
    }

    #[test]
    fn early_failure_releases_the_lease() {
        let port = FakePort::default();
        port.register("k", std::path::Path::new("/x"));
        let resource = port.resolve(b"k").unwrap();
        assert!(resource.start());
        let lease = Lease::started(resource);
        fn open_failing(_lease: Lease) -> Result<(), String> {
            Err("SQLITE_OPEN_FAILED".to_string())
        }
        let result = open_failing(lease);
        assert!(result.is_err());
        assert_eq!(port.active(), 0);
    }
}
