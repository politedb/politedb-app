//! Grant lookup and leasing. Disabled in direct builds: every call succeeds without
//! touching the store, and paths open as typed.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::error::{self, Role};
use super::lease::Lease;
use super::port::{BookmarkPort, PortError};
use super::store::{GrantRecord, GrantStore};
use super::validate;

/// A file a connection needs. For `DatabaseFolder` the path is the database file; the
/// grant covers its parent folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRequest {
    pub role: Role,
    pub path: String,
}

pub struct FileAccess {
    enabled: Option<Enabled>,
}

struct Enabled {
    store: GrantStore,
    /// One lock for load → resolve → refresh → save (plan S6).
    lock: Mutex<()>,
    port: Arc<dyn BookmarkPort>,
}

impl FileAccess {
    pub fn disabled() -> Self {
        Self { enabled: None }
    }

    pub fn enabled(store_path: PathBuf, port: Arc<dyn BookmarkPort>) -> Self {
        Self {
            enabled: Some(Enabled {
                store: GrantStore::new(store_path),
                lock: Mutex::new(()),
                port,
            }),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.is_some()
    }

    /// Lease for a database file; `None` when not needed (direct build, `:memory:`).
    pub fn acquire_database(&self, db_path: &str) -> Result<Option<Lease>, String> {
        if is_in_memory(db_path) {
            return Ok(None);
        }
        self.acquire(Role::DatabaseFolder, db_path)
    }

    /// Lease for `path` in `role`. Fails with `FILE_ACCESS_REQUIRED` when there is no
    /// usable grant, so the frontend can ask the user to pick it again.
    pub fn acquire(&self, role: Role, path: &str) -> Result<Option<Lease>, String> {
        let Some(enabled) = &self.enabled else {
            return Ok(None);
        };
        let keys = grant_keys(role, path)?;
        let _guard = enabled
            .lock
            .lock()
            .map_err(|_| error::STORE_IO.to_string())?;
        let mut grants = enabled.store.load()?;
        let Some(index) = grants
            .iter()
            .position(|g| g.role == role && keys.iter().any(|k| Path::new(&g.path) == k))
        else {
            return Err(error::required(role));
        };
        let record = grants[index].clone();
        let bytes = record
            .bookmark_bytes()
            .ok_or_else(|| error::required(role))?;
        let resource = enabled.port.resolve(&bytes).map_err(|e| match e {
            PortError::Unavailable => error::unavailable(role),
            PortError::Corrupt | PortError::Denied => error::required(role),
        })?;
        // A moved, renamed or replaced item resolves elsewhere: never open it silently.
        if resource.path() != Path::new(&record.path) {
            return Err(error::required(role));
        }
        if !resource.start() {
            return Err(error::required(role));
        }
        let lease = Lease::started(resource);
        // Same path, different item (e.g. the folder was replaced): not what the user
        // granted. Dropping `lease` stops access again.
        if record.file_id.is_some() && validate::file_id(Path::new(&record.path)) != record.file_id
        {
            return Err(error::required(role));
        }
        if lease.stale() {
            // Best effort: on failure the old bookmark stays and still worked this time.
            if let Ok(fresh) = lease.bookmark(role.read_only()) {
                grants[index] = GrantRecord::new(role, Path::new(&record.path), &fresh)
                    .with_file_id(record.file_id.clone());
                let _ = enabled.store.save(&grants);
            }
        }
        Ok(Some(lease))
    }

    /// Requests that have no usable grant right now. Each stored grant is resolved and
    /// briefly started (no panels), so stale, moved or denied grants are found before
    /// anything is saved (plan P1-3). A file that is gone or on an unmounted volume
    /// fails with `FILE_ACCESS_UNAVAILABLE`, since picking again would not help.
    pub fn missing(&self, requests: &[AccessRequest]) -> Result<Vec<AccessRequest>, String> {
        if self.enabled.is_none() {
            return Ok(Vec::new());
        }
        let mut missing = Vec::new();
        for request in requests {
            if request.role == Role::DatabaseFolder && is_in_memory(&request.path) {
                continue;
            }
            match self.acquire(request.role, &request.path) {
                Ok(_lease) => {}
                Err(e) if e.starts_with("FILE_ACCESS_REQUIRED") || e == error::INVALID_PATH => {
                    if !missing.contains(request) {
                        missing.push(request.clone());
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Ok(missing)
    }

    /// Stores a bookmark created by a backend picker for `grant_path` (already
    /// validated and canonical). Replaces any previous grant for the same item.
    pub(super) fn record(
        &self,
        role: Role,
        grant_path: &Path,
        bookmark: &[u8],
    ) -> Result<(), String> {
        let Some(enabled) = &self.enabled else {
            return Ok(());
        };
        let _guard = enabled
            .lock
            .lock()
            .map_err(|_| error::STORE_IO.to_string())?;
        let mut grants = enabled.store.load()?;
        grants.retain(|g| !(g.role == role && Path::new(&g.path) == grant_path));
        grants.push(
            GrantRecord::new(role, grant_path, bookmark)
                .with_file_id(validate::file_id(grant_path)),
        );
        enabled.store.save(&grants)
    }
}

pub fn is_in_memory(db_path: &str) -> bool {
    let trimmed = db_path.trim();
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case(":memory:")
}

/// Paths a grant for `path` may be stored under: the lexical form (what pickers store)
/// and, when the filesystem allows it, the canonical form (imported or typed paths).
fn grant_keys(role: Role, path: &str) -> Result<Vec<PathBuf>, String> {
    let item = normalize_absolute(Path::new(path.trim()))?;
    let target = match role {
        Role::DatabaseFolder => item
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| error::INVALID_PATH.to_string())?,
        Role::SshKey => item,
    };
    let mut keys = vec![target.clone()];
    if let Ok(canonical) = std::fs::canonicalize(&target) {
        if canonical != target {
            keys.push(canonical);
        }
    }
    Ok(keys)
}

/// Absolute path without `.`; `..` is rejected rather than resolved.
pub fn normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(error::INVALID_PATH.into());
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => return Err(error::INVALID_PATH.into()),
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::test_support::{FakePort, FakeTarget, TempDir};

    struct Fixture {
        dir: TempDir,
        port: Arc<FakePort>,
        access: FileAccess,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new();
        let port = Arc::new(FakePort::default());
        let access = FileAccess::enabled(dir.path().join("grants.json"), port.clone());
        Fixture { dir, port, access }
    }

    fn db_in(dir: &Path) -> String {
        dir.join("app.db").to_string_lossy().into_owned()
    }

    #[test]
    fn disabled_service_needs_nothing() {
        let access = FileAccess::disabled();
        assert!(access.acquire_database("/x/app.db").unwrap().is_none());
        assert!(access
            .missing(&[AccessRequest {
                role: Role::SshKey,
                path: "/k".into()
            }])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn in_memory_databases_need_no_grant() {
        let f = fixture();
        assert!(f.access.acquire_database(":memory:").unwrap().is_none());
        assert!(f.access.acquire_database(" :MEMORY: ").unwrap().is_none());
    }

    #[test]
    fn missing_grant_is_reported_without_a_path() {
        let f = fixture();
        let err = f.access.acquire_database(&db_in(f.dir.path())).unwrap_err();
        assert_eq!(err, r#"FILE_ACCESS_REQUIRED:{"role":"database_folder"}"#);
        assert!(!err.contains(f.dir.path().to_str().unwrap()));
    }

    #[test]
    fn folder_grant_leases_and_stops_once() {
        let f = fixture();
        f.port.register("folder", f.dir.path());
        f.access
            .record(Role::DatabaseFolder, f.dir.path(), b"folder")
            .unwrap();
        let lease = f.access.acquire_database(&db_in(f.dir.path())).unwrap();
        assert!(lease.is_some());
        assert_eq!(f.port.active(), 1);
        drop(lease);
        assert_eq!(f.port.active(), 0);
        assert_eq!(f.port.stops.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn independent_leases_are_balanced() {
        let f = fixture();
        f.port.register("folder", f.dir.path());
        f.access
            .record(Role::DatabaseFolder, f.dir.path(), b"folder")
            .unwrap();
        let a = f.access.acquire_database(&db_in(f.dir.path())).unwrap();
        let b = f.access.acquire_database(&db_in(f.dir.path())).unwrap();
        assert_eq!(f.port.active(), 2);
        drop(a);
        assert_eq!(f.port.active(), 1);
        drop(b);
        assert_eq!(f.port.active(), 0);
    }

    #[test]
    fn moved_items_are_not_opened_elsewhere() {
        let f = fixture();
        f.port.register("folder", Path::new("/somewhere/else"));
        f.access
            .record(Role::DatabaseFolder, f.dir.path(), b"folder")
            .unwrap();
        let err = f.access.acquire_database(&db_in(f.dir.path())).unwrap_err();
        assert!(err.starts_with("FILE_ACCESS_REQUIRED"));
        assert_eq!(f.port.active(), 0);
    }

    #[test]
    fn unavailable_and_denied_map_to_codes() {
        let f = fixture();
        f.access
            .record(Role::SshKey, Path::new("/k/id"), b"gone")
            .unwrap();
        f.port.set(
            "gone",
            FakeTarget {
                path: "/k/id".into(),
                stale: false,
                start_ok: true,
                error: Some(PortError::Unavailable),
            },
        );
        assert_eq!(
            f.access.acquire(Role::SshKey, "/k/id").unwrap_err(),
            r#"FILE_ACCESS_UNAVAILABLE:{"role":"ssh_key"}"#
        );
        f.port.set(
            "gone",
            FakeTarget {
                path: "/k/id".into(),
                stale: false,
                start_ok: false,
                error: None,
            },
        );
        assert!(f
            .access
            .acquire(Role::SshKey, "/k/id")
            .unwrap_err()
            .starts_with("FILE_ACCESS_REQUIRED"));
        assert_eq!(f.port.active(), 0);
    }

    #[test]
    fn stale_bookmarks_are_refreshed() {
        let f = fixture();
        f.port.set(
            "old",
            FakeTarget {
                path: "/k/id".into(),
                stale: true,
                start_ok: true,
                error: None,
            },
        );
        f.access
            .record(Role::SshKey, Path::new("/k/id"), b"old")
            .unwrap();
        let _lease = f.access.acquire(Role::SshKey, "/k/id").unwrap();
        assert_eq!(
            f.port.refreshed.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let stored = GrantStore::new(f.dir.path().join("grants.json"))
            .load()
            .unwrap();
        assert_eq!(stored[0].bookmark_bytes().unwrap(), b"refreshed");
    }

    #[test]
    fn record_replaces_the_previous_grant() {
        let f = fixture();
        f.access
            .record(Role::SshKey, Path::new("/k/id"), b"a")
            .unwrap();
        f.access
            .record(Role::SshKey, Path::new("/k/id"), b"b")
            .unwrap();
        let stored = GrantStore::new(f.dir.path().join("grants.json"))
            .load()
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].bookmark_bytes().unwrap(), b"b");
    }

    #[test]
    fn missing_lists_each_request_once() {
        let f = fixture();
        f.port.register("folder", f.dir.path());
        f.access
            .record(Role::DatabaseFolder, f.dir.path(), b"folder")
            .unwrap();
        let have = AccessRequest {
            role: Role::DatabaseFolder,
            path: db_in(f.dir.path()),
        };
        let need = AccessRequest {
            role: Role::SshKey,
            path: "/k/id".into(),
        };
        let mem = AccessRequest {
            role: Role::DatabaseFolder,
            path: ":memory:".into(),
        };
        let missing = f
            .access
            .missing(&[have, need.clone(), need.clone(), mem])
            .unwrap();
        assert_eq!(missing, vec![need]);
        assert_eq!(f.port.active(), 0, "the check must not keep access");
    }

    #[test]
    fn missing_finds_grants_that_no_longer_work() {
        let f = fixture();
        f.access
            .record(Role::SshKey, Path::new("/k/id"), b"broken")
            .unwrap();
        // Stored but unresolvable (corrupt) → needs a new pick.
        let request = AccessRequest {
            role: Role::SshKey,
            path: "/k/id".into(),
        };
        assert_eq!(
            f.access.missing(std::slice::from_ref(&request)).unwrap(),
            vec![request.clone()]
        );
        // Gone for good → no picker would help.
        f.port.set(
            "broken",
            FakeTarget {
                path: "/k/id".into(),
                stale: false,
                start_ok: true,
                error: Some(PortError::Unavailable),
            },
        );
        assert!(f
            .access
            .missing(&[request])
            .unwrap_err()
            .starts_with("FILE_ACCESS_UNAVAILABLE"));
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_folder_is_not_trusted() {
        let f = fixture();
        let folder = f.dir.path().join("data");
        std::fs::create_dir(&folder).unwrap();
        f.port.register("folder", &folder);
        f.access
            .record(Role::DatabaseFolder, &folder, b"folder")
            .unwrap();
        let db = folder.join("app.db").to_string_lossy().into_owned();
        assert!(f.access.acquire_database(&db).unwrap().is_some());
        std::fs::remove_dir(&folder).unwrap();
        std::fs::write(f.dir.path().join("spacer"), b"x").unwrap();
        std::fs::create_dir(&folder).unwrap();
        assert!(f
            .access
            .acquire_database(&db)
            .unwrap_err()
            .starts_with("FILE_ACCESS_REQUIRED"));
        assert_eq!(f.port.active(), 0);
    }

    #[test]
    fn relative_and_parent_paths_are_rejected() {
        let f = fixture();
        assert_eq!(
            f.access.acquire_database("app.db").unwrap_err(),
            error::INVALID_PATH
        );
        assert_eq!(
            f.access.acquire(Role::SshKey, "/k/../etc/id").unwrap_err(),
            error::INVALID_PATH
        );
    }
}
