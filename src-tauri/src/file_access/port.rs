//! Native bookmark operations behind a narrow port so the service is testable.

use std::path::PathBuf;

/// Why a bookmark could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortError {
    /// The item no longer exists or its volume is not mounted.
    Unavailable,
    /// The bookmark data is unreadable.
    Corrupt,
    /// The system refused access.
    Denied,
}

/// A resolved security-scoped resource. Implementations keep the native URL that
/// resolution returned; start/stop and refresh must use that same object (Apple's
/// contract), never a URL rebuilt from `path`.
pub trait ScopedResource: Send + Sync {
    fn path(&self) -> PathBuf;
    fn stale(&self) -> bool;
    /// `startAccessingSecurityScopedResource`; `false` means no access.
    fn start(&self) -> bool;
    /// Balances a successful `start`.
    fn stop(&self);
    /// New bookmark data for this resource (used to refresh stale bookmarks).
    fn bookmark(&self, read_only: bool) -> Result<Vec<u8>, PortError>;
}

pub trait BookmarkPort: Send + Sync {
    fn resolve(&self, bookmark: &[u8]) -> Result<Box<dyn ScopedResource>, PortError>;
}

/// Platforms without security-scoped bookmarks.
#[cfg(not(target_os = "macos"))]
pub struct Unsupported;

#[cfg(not(target_os = "macos"))]
impl BookmarkPort for Unsupported {
    fn resolve(&self, _bookmark: &[u8]) -> Result<Box<dyn ScopedResource>, PortError> {
        Err(PortError::Denied)
    }
}
