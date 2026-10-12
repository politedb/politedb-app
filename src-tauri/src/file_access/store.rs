//! `grants.json`: bookmarks for user-picked folders/files, private to this machine.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::error::{self, Role};

const VERSION: u32 = 1;
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_GRANTS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantRecord {
    pub role: Role,
    /// Canonical absolute path the grant was created for.
    pub path: String,
    /// Base64 security-scoped bookmark.
    pub bookmark: String,
    /// `device:inode` when the grant was made; a different item at the same path is
    /// not trusted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

impl GrantRecord {
    pub fn new(role: Role, path: &Path, bookmark: &[u8]) -> Self {
        Self {
            role,
            path: path.to_string_lossy().into_owned(),
            bookmark: base64::engine::general_purpose::STANDARD.encode(bookmark),
            file_id: None,
        }
    }

    pub fn with_file_id(mut self, file_id: Option<String>) -> Self {
        self.file_id = file_id;
        self
    }

    /// `None` for undecodable data; the caller treats the grant as missing.
    pub fn bookmark_bytes(&self) -> Option<Vec<u8>> {
        base64::engine::general_purpose::STANDARD
            .decode(&self.bookmark)
            .ok()
            .filter(|bytes| !bytes.is_empty())
    }
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    grants: Vec<GrantRecord>,
}

pub struct GrantStore {
    path: PathBuf,
}

impl GrantStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Missing file → no grants. A file that is too large, unparsable or from another
    /// version is moved aside (`grants.json.corrupt-<ts>`) so one bad write cannot
    /// block every connection; I/O errors propagate.
    pub fn load(&self) -> Result<Vec<GrantRecord>, String> {
        let meta = match std::fs::metadata(&self.path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(error::STORE_IO.into()),
        };
        if meta.len() > MAX_BYTES {
            return self.quarantine();
        }
        let bytes = std::fs::read(&self.path).map_err(|_| error::STORE_IO.to_string())?;
        match serde_json::from_slice::<StoreFile>(&bytes) {
            Ok(file) if file.version == VERSION => Ok(file.grants),
            _ => self.quarantine(),
        }
    }

    pub fn save(&self, grants: &[GrantRecord]) -> Result<(), String> {
        // Newest grants are appended last; keep the most recent ones.
        let start = grants.len().saturating_sub(MAX_GRANTS);
        let file = StoreFile {
            version: VERSION,
            grants: grants[start..].to_vec(),
        };
        crate::file_storage::json_replace_preserving_private(&self.path, &file)
            .map_err(|_| error::STORE_IO.to_string())
    }

    fn quarantine(&self) -> Result<Vec<GrantRecord>, String> {
        let stamp = chrono::Utc::now().timestamp_millis();
        let aside = self
            .path
            .with_file_name(format!("grants.json.corrupt-{stamp}"));
        std::fs::rename(&self.path, &aside).map_err(|_| error::STORE_IO.to_string())?;
        tracing::warn!(code = error::STORE_CORRUPT, "file access grant store reset");
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::file_access::test_support::TempDir;

    fn store() -> (TempDir, GrantStore) {
        let dir = TempDir::new();
        let store = GrantStore::new(dir.path().join("grants.json"));
        (dir, store)
    }

    #[test]
    fn round_trips_and_is_private() {
        let (_dir, store) = store();
        assert!(store.load().unwrap().is_empty());
        let grant = GrantRecord::new(Role::DatabaseFolder, Path::new("/data"), b"bm");
        store.save(std::slice::from_ref(&grant)).unwrap();
        assert_eq!(store.load().unwrap(), vec![grant]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&store.path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn corrupt_store_is_moved_aside() {
        let (dir, store) = store();
        std::fs::write(&store.path, b"{not json").unwrap();
        assert!(store.load().unwrap().is_empty());
        assert!(!store.path.exists());
        let aside = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("grants.json.corrupt-")
            });
        assert!(aside);
    }

    #[test]
    fn other_versions_are_not_trusted() {
        let (_dir, store) = store();
        std::fs::write(&store.path, br#"{"version":2,"grants":[]}"#).unwrap();
        assert!(store.load().unwrap().is_empty());
        assert!(!store.path.exists());
    }

    #[test]
    fn keeps_the_newest_grants_within_the_cap() {
        let (_dir, store) = store();
        let grants: Vec<_> = (0..MAX_GRANTS + 3)
            .map(|i| GrantRecord::new(Role::SshKey, Path::new(&format!("/k{i}")), b"x"))
            .collect();
        store.save(&grants).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), MAX_GRANTS);
        assert_eq!(loaded.last().unwrap().path, format!("/k{}", MAX_GRANTS + 2));
    }

    #[test]
    fn undecodable_bookmark_reads_as_missing() {
        let mut grant = GrantRecord::new(Role::SshKey, Path::new("/k"), b"x");
        grant.bookmark = "%%%".into();
        assert!(grant.bookmark_bytes().is_none());
    }
}
