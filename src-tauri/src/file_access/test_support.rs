//! Test helpers: a self-deleting temp dir and a fake bookmark port.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::port::{BookmarkPort, PortError, ScopedResource};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("politedb-fa-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Canonical so comparisons match canonicalized paths (/var → /private/var).
        Self(std::fs::canonicalize(dir).unwrap())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What a fake bookmark resolves to.
#[derive(Clone)]
pub struct FakeTarget {
    pub path: PathBuf,
    pub stale: bool,
    pub start_ok: bool,
    pub error: Option<PortError>,
}

/// Bookmarks are the UTF-8 key of a registered target.
#[derive(Default)]
pub struct FakePort {
    pub targets: Mutex<HashMap<String, FakeTarget>>,
    pub starts: Arc<AtomicUsize>,
    pub stops: Arc<AtomicUsize>,
    pub refreshed: Arc<AtomicUsize>,
}

impl FakePort {
    pub fn register(&self, key: &str, path: &Path) {
        self.set(
            key,
            FakeTarget {
                path: path.to_path_buf(),
                stale: false,
                start_ok: true,
                error: None,
            },
        );
    }

    pub fn set(&self, key: &str, target: FakeTarget) {
        self.targets.lock().unwrap().insert(key.into(), target);
    }

    pub fn active(&self) -> usize {
        self.starts.load(Ordering::SeqCst) - self.stops.load(Ordering::SeqCst)
    }
}

struct FakeResource {
    target: FakeTarget,
    starts: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    refreshed: Arc<AtomicUsize>,
}

impl ScopedResource for FakeResource {
    fn path(&self) -> PathBuf {
        self.target.path.clone()
    }
    fn stale(&self) -> bool {
        self.target.stale
    }
    fn start(&self) -> bool {
        if self.target.start_ok {
            self.starts.fetch_add(1, Ordering::SeqCst);
        }
        self.target.start_ok
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
    }
    fn bookmark(&self, _read_only: bool) -> Result<Vec<u8>, PortError> {
        self.refreshed.fetch_add(1, Ordering::SeqCst);
        Ok(b"refreshed".to_vec())
    }
}

impl BookmarkPort for FakePort {
    fn resolve(&self, bookmark: &[u8]) -> Result<Box<dyn ScopedResource>, PortError> {
        let key = String::from_utf8_lossy(bookmark).into_owned();
        let target = self
            .targets
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
            .ok_or(PortError::Corrupt)?;
        if let Some(error) = target.error {
            return Err(error);
        }
        Ok(Box::new(FakeResource {
            target,
            starts: self.starts.clone(),
            stops: self.stops.clone(),
            refreshed: self.refreshed.clone(),
        }))
    }
}
