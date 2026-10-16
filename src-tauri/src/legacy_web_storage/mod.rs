//! Restores localStorage written by builds before 1.5, when the bundle identifier
//! was `com.politehq.politedb` (plan legacy-webkit-storage).
//!
//! The WebView keeps localStorage in a store named after the identifier, so the
//! 1.5 identifier change left settings, groups, pins, shortcuts and chats behind.
//! This module reads that old store from a private copy and returns the allowlisted
//! keys; the frontend writes the ones it does not have yet. The old store is never
//! written, moved or deleted.
//!
//! - macOS / Linux: WebKit's SQLite store ([`webkit`]).
//! - Windows: WebView2's LevelDB store ([`chromium`]).

#[cfg(any(windows, test))]
mod chromium;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod webkit;

use std::fs;
use std::path::{Path, PathBuf};

/// Bundle identifier before 1.5.
pub const LEGACY_IDENTIFIER: &str = "com.politehq.politedb";

/// Keys the current app reads. Anything else in the old store (removed features,
/// analytics session ids, third-party keys) is left behind.
const EXACT_KEYS: &[&str] = &[
    "politedb:app-settings:v1",
    "politedb.connection-groups.v1",
    "politedb.pinned-connections.v1",
    "politedb.keyboard-shortcuts.v1",
    "politedb.ai.provider.selected",
    "politedb.ai.model.selectionMode",
    "politedb.ai.legacyLocalNotice.dismissed",
    "politedb.analytics.consent",
    "politedb.analytics.install_date",
    "politedb:welcome:seen",
];
const KEY_PREFIXES: &[&str] = &["politedb.ai.chat.", "politedb.ai.model.selected."];

const MAX_KEYS: usize = 2_000;
const MAX_VALUE_BYTES: usize = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;
/// Stores larger than this are not copied at all.
const MAX_STORE_BYTES: u64 = 100 * 1024 * 1024;

pub fn is_allowed(key: &str) -> bool {
    EXACT_KEYS.contains(&key) || KEY_PREFIXES.iter().any(|p| key.starts_with(p))
}

/// Entries to restore, and how many allowlisted entries were dropped (undecodable
/// or over a cap).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Restored {
    pub entries: Vec<(String, String)>,
    pub skipped: usize,
}

/// Why an existing old store could not be read. Kinds only: never paths or data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    TooLarge,
    Ambiguous,
    Copy,
    Open,
    Query,
}

impl ReadError {
    pub fn kind(self) -> &'static str {
        match self {
            Self::TooLarge => "too_large",
            Self::Ambiguous => "ambiguous_origin",
            Self::Copy => "copy",
            Self::Open => "open",
            Self::Query => "query",
        }
    }
}

/// Where the old store lives on this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyStore {
    /// WebKit: per-origin folders under `general` (`<hash>/<hash>/origin`), or the
    /// older flat `<scheme>_<host>_0.localstorage` files under `flat`. Every folder
    /// from `root` down must be a real directory (no symlinks).
    #[allow(dead_code)]
    WebKit {
        root: PathBuf,
        general: PathBuf,
        flat: PathBuf,
    },
    /// WebView2: the profile's `Local Storage/leveldb` directory under `root`.
    #[allow(dead_code)]
    Chromium { root: PathBuf, leveldb: PathBuf },
}

/// The old store for this platform, from the home and local-data directories.
#[allow(unused_variables)]
pub fn legacy_store(home: Option<&Path>, local_data: Option<&Path>) -> Option<LegacyStore> {
    #[cfg(target_os = "macos")]
    {
        let root = home?.join("Library/WebKit").join(LEGACY_IDENTIFIER);
        let base = root.join("WebsiteData");
        Some(LegacyStore::WebKit {
            general: base.join("Default"),
            flat: base.join("LocalStorage"),
            root,
        })
    }
    #[cfg(target_os = "linux")]
    {
        // Tauri points WebKitGTK at `<local data>/<identifier>`.
        let root = local_data?.join(LEGACY_IDENTIFIER);
        Some(LegacyStore::WebKit {
            general: root.join("storage"),
            flat: root.join("localstorage"),
            root,
        })
    }
    #[cfg(windows)]
    {
        // Tauri points WebView2 at `<local data>/<identifier>`.
        let root = local_data?.join(LEGACY_IDENTIFIER);
        Some(LegacyStore::Chromium {
            leveldb: root
                .join("EBWebView")
                .join("Default")
                .join("Local Storage")
                .join("leveldb"),
            root,
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        None
    }
}

/// Reads the allowlisted entries from `store`. A missing store is an empty result.
pub fn read(store: &LegacyStore) -> Result<Restored, ReadError> {
    let (raw, invalid) = match store {
        #[cfg(any(target_os = "macos", target_os = "linux", test))]
        LegacyStore::WebKit {
            root,
            general,
            flat,
        } => {
            let general = real_dir_chain(root, general).then_some(general.as_path());
            let flat = real_dir_chain(root, flat).then_some(flat.as_path());
            match webkit::find_database(general, flat)? {
                Some(database) => webkit::read_items(&database)?,
                None => return Ok(Restored::default()),
            }
        }
        #[cfg(any(windows, test))]
        LegacyStore::Chromium { root, leveldb } => {
            if !real_dir_chain(root, leveldb) {
                return Ok(Restored::default());
            }
            chromium::read_items(leveldb)?
        }
        #[allow(unreachable_patterns)]
        _ => return Ok(Restored::default()),
    };
    Ok(select(raw, invalid))
}

/// Applies the allowlist and the caps. `invalid` counts allowlisted rows the reader
/// could not decode.
fn select(raw: Vec<(String, String)>, invalid: usize) -> Restored {
    let mut restored = Restored {
        entries: Vec::new(),
        skipped: invalid,
    };
    let mut total = 0usize;
    for (key, value) in raw {
        if !is_allowed(&key) {
            continue;
        }
        let size = key.len() + value.len();
        if restored.entries.len() == MAX_KEYS
            || value.len() > MAX_VALUE_BYTES
            || total + size > MAX_TOTAL_BYTES
        {
            restored.skipped += 1;
            continue;
        }
        total += size;
        restored.entries.push((key, value));
    }
    restored
}

/// `root` and every folder from it down to `path` are real directories, so no
/// symlink can redirect the read outside the old store.
fn real_dir_chain(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if !is_real_dir(root) {
        return false;
    }
    let mut current = root.to_path_buf();
    relative.components().all(|component| {
        current.push(component);
        is_real_dir(&current)
    })
}

/// A directory that is not a symlink.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

/// A regular file that is not a symlink.
#[cfg_attr(windows, allow(dead_code))]
fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// A private scratch directory, removed on drop.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new() -> Result<Self, ReadError> {
        let path =
            std::env::temp_dir().join(format!("politedb-legacy-storage-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|_| ReadError::Copy)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Copies regular (non-symlink) files into `dest`, keeping their names, under the
/// store size cap. Missing optional files are fine; `required` must exist.
fn copy_files(files: &[(PathBuf, bool)], dest: &Path, budget: &mut u64) -> Result<(), ReadError> {
    for (source, required) in files {
        let Ok(meta) = fs::symlink_metadata(source) else {
            if *required {
                return Err(ReadError::Copy);
            }
            continue;
        };
        if !meta.is_file() {
            return Err(ReadError::Copy);
        }
        if meta.len() > *budget {
            return Err(ReadError::TooLarge);
        }
        *budget -= meta.len();
        let name = source.file_name().ok_or(ReadError::Copy)?;
        fs::copy(source, dest.join(name)).map_err(|_| ReadError::Copy)?;
    }
    Ok(())
}

fn utf16le(bytes: &[u8]) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(key: &str, value: &str) -> (String, String) {
        (key.to_string(), value.to_string())
    }

    #[test]
    fn only_keys_the_app_reads_are_restored() {
        for key in [
            "politedb:app-settings:v1",
            "politedb.connection-groups.v1",
            "politedb.ai.chat.global-ai-assistant",
            "politedb.ai.chat.tab-29a91fae-23d9-4c1f-96fa-09187f63a905",
            "politedb.ai.model.selected.openai-1",
            "politedb.analytics.consent",
        ] {
            assert!(is_allowed(key), "{key}");
        }
        for key in [
            "politedb.ai.endpoint",
            "politedb.ai.model",
            "politedb.ai.model.seen",
            "politedb.analytics.session_id",
            "politedb.analytics.last_active_date",
            "politedb.migration.legacyWebStorage.v1",
            "ph_phc_x_posthog",
            "politedb:app-settings:v1x",
            "",
        ] {
            assert!(!is_allowed(key), "{key}");
        }
    }

    #[test]
    fn select_filters_and_caps() {
        let restored = select(
            vec![
                pair("politedb:welcome:seen", "1"),
                pair("politedb.ai.endpoint", "http://x"),
                pair("politedb.ai.chat.a", &"x".repeat(MAX_VALUE_BYTES + 1)),
            ],
            2,
        );
        assert_eq!(restored.entries, vec![pair("politedb:welcome:seen", "1")]);
        assert_eq!(restored.skipped, 3);

        let many: Vec<_> = (0..MAX_KEYS + 5)
            .map(|i| pair(&format!("politedb.ai.chat.{i}"), "v"))
            .collect();
        let restored = select(many, 0);
        assert_eq!(restored.entries.len(), MAX_KEYS);
        assert_eq!(restored.skipped, 5);

        let big = "x".repeat(MAX_VALUE_BYTES);
        let rows: Vec<_> = (0..5)
            .map(|i| pair(&format!("politedb.ai.chat.{i}"), &big))
            .collect();
        let restored = select(rows, 0);
        assert_eq!(restored.entries.len(), 3);
        assert_eq!(restored.skipped, 2);
    }

    #[test]
    fn decodes_utf16le() {
        let bytes: Vec<u8> = "chào".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(utf16le(&bytes).as_deref(), Some("chào"));
        assert_eq!(utf16le(&[0x41]), None);
        assert_eq!(utf16le(&[0x00, 0xD8]), None); // lone surrogate
    }

    #[test]
    fn missing_stores_are_empty() {
        let root =
            std::env::temp_dir().join(format!("politedb-legacy-none-{}", uuid::Uuid::new_v4()));
        for store in [
            LegacyStore::WebKit {
                root: root.clone(),
                general: root.join("Default"),
                flat: root.join("LocalStorage"),
            },
            LegacyStore::Chromium {
                root: root.clone(),
                leveldb: root.join("leveldb"),
            },
        ] {
            assert_eq!(read(&store), Ok(Restored::default()));
        }
    }

    #[test]
    fn platform_paths_use_the_legacy_identifier() {
        let home = Path::new("/home/u");
        let local = Path::new("/local");
        let store = legacy_store(Some(home), Some(local));
        #[cfg(target_os = "macos")]
        assert_eq!(
            store,
            Some(LegacyStore::WebKit {
                root: home.join("Library/WebKit/com.politehq.politedb"),
                general: home.join("Library/WebKit/com.politehq.politedb/WebsiteData/Default"),
                flat: home.join("Library/WebKit/com.politehq.politedb/WebsiteData/LocalStorage"),
            })
        );
        #[cfg(target_os = "linux")]
        assert_eq!(
            store,
            Some(LegacyStore::WebKit {
                root: local.join("com.politehq.politedb"),
                general: local.join("com.politehq.politedb/storage"),
                flat: local.join("com.politehq.politedb/localstorage"),
            })
        );
        #[cfg(windows)]
        assert_eq!(
            store,
            Some(LegacyStore::Chromium {
                root: local.join("com.politehq.politedb"),
                leveldb: local
                    .join("com.politehq.politedb")
                    .join("EBWebView")
                    .join("Default")
                    .join("Local Storage")
                    .join("leveldb"),
            })
        );
        assert_eq!(legacy_store(None, None), None);
    }

    /// Reads this machine's real pre-1.5 store (through a private copy) and prints
    /// only counts: never keys or values. Run explicitly:
    /// `cargo test real_legacy_store_smoke -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_legacy_store_smoke() {
        let home = dirs::home_dir();
        let local = dirs::data_local_dir();
        let store = legacy_store(home.as_deref(), local.as_deref()).expect("platform store");
        let restored = read(&store).expect("readable");
        println!(
            "entries={} skipped={}",
            restored.entries.len(),
            restored.skipped
        );
    }
}
