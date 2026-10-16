//! WebView2 (Chromium) localStorage: a LevelDB directory. Data entries are keyed
//! `_<origin>\0<name>`; names and values start with an encoding byte (0 = UTF-16LE,
//! 1 = Latin-1). `VERSION`, `META:` and `METAACCESS:` entries are bookkeeping.

use std::fs;
use std::path::Path;

use rusty_leveldb::{LdbIterator, Options, DB};

use super::{copy_files, utf16le, ReadError, ScratchDir, MAX_STORE_BYTES};

/// Tauri v2 serves the app from `http://tauri.localhost` on Windows
/// (`https://` when `useHttpsScheme` is set).
const ORIGINS: &[&[u8]] = &[b"http://tauri.localhost", b"https://tauri.localhost"];

/// All entries for the app origin, read from a private copy (LevelDB recovers and
/// may compact on open, so the original is never opened), and how many allowlisted
/// entries could not be decoded.
pub fn read_items(leveldb: &Path) -> Result<(Vec<(String, String)>, usize), ReadError> {
    let scratch = ScratchDir::new()?;
    let mut files = Vec::new();
    for entry in fs::read_dir(leveldb)
        .map_err(|_| ReadError::Copy)?
        .flatten()
    {
        let path = entry.path();
        // Another process's lock file is not part of the data.
        if entry.file_name() == "LOCK" {
            continue;
        }
        // Only regular files at the top level (LevelDB has no subdirectories).
        if fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            files.push((path, true));
        }
    }
    let mut budget = MAX_STORE_BYTES;
    copy_files(&files, scratch.path(), &mut budget)?;

    let options = Options {
        create_if_missing: false,
        ..Options::default()
    };
    let mut db = DB::open(scratch.path(), options).map_err(|_| ReadError::Open)?;
    let mut iter = db.new_iter().map_err(|_| ReadError::Query)?;
    let mut items = Vec::new();
    let mut invalid = 0;
    while let Some((key, value)) = iter.next() {
        let Some(name) = app_entry_name(&key) else {
            continue;
        };
        match (decode(name), decode(&value)) {
            (Some(name), Some(value)) => items.push((name, value)),
            (Some(name), None) if super::is_allowed(&name) => invalid += 1,
            _ => {}
        }
    }
    Ok((items, invalid))
}

/// The encoded name of a data entry for the app origin.
fn app_entry_name(key: &[u8]) -> Option<&[u8]> {
    let rest = key.strip_prefix(b"_")?;
    let separator = rest.iter().position(|&b| b == 0)?;
    let (origin, name) = (&rest[..separator], &rest[separator + 1..]);
    ORIGINS.contains(&origin).then_some(name)
}

fn decode(bytes: &[u8]) -> Option<String> {
    match bytes.split_first()? {
        (0, rest) => utf16le(rest),
        (1, rest) => Some(rest.iter().map(|&b| b as char).collect()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy_web_storage::{read, LegacyStore, Restored};
    use rusty_leveldb::CompressorId;
    use std::path::PathBuf;

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("politedb-chromium-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn leveldb(&self) -> PathBuf {
            self.0.join("leveldb")
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn latin1(s: &str) -> Vec<u8> {
        let mut out = vec![1];
        out.extend(s.chars().map(|c| c as u8));
        out
    }

    fn utf16(s: &str) -> Vec<u8> {
        let mut out = vec![0];
        out.extend(s.encode_utf16().flat_map(u16::to_le_bytes));
        out
    }

    fn entry(origin: &str, name: Vec<u8>) -> Vec<u8> {
        let mut key = b"_".to_vec();
        key.extend(origin.as_bytes());
        key.push(0);
        key.extend(name);
        key
    }

    /// Writes a store the way Chromium lays it out, with snappy-compressed tables
    /// plus recent writes left in the log.
    fn write_store(dir: &Path, flushed: &[(Vec<u8>, Vec<u8>)], logged: &[(Vec<u8>, Vec<u8>)]) {
        let options = Options {
            compressor: rusty_leveldb::compressor::SnappyCompressor::ID,
            ..Options::default()
        };
        let mut db = DB::open(dir, options).unwrap();
        db.put(b"VERSION", b"1").unwrap();
        db.put(b"META:http://tauri.localhost", b"\x08\x01").unwrap();
        for (k, v) in flushed {
            db.put(k, v).unwrap();
        }
        db.flush().unwrap();
        db.compact_range(b"\x00", b"\xff").unwrap();
        for (k, v) in logged {
            db.put(k, v).unwrap();
        }
        db.flush().unwrap();
        // Dropped without close: recent writes stay in the log, like a live profile.
    }

    #[test]
    fn reads_the_app_origin_in_both_encodings_and_leaves_the_source_alone() {
        let root = Root::new();
        write_store(
            &root.leveldb(),
            &[
                (
                    entry("http://tauri.localhost", latin1("politedb:app-settings:v1")),
                    latin1(r#"{"theme":"dark"}"#),
                ),
                (
                    entry(
                        "http://tauri.localhost",
                        utf16("politedb.ai.chat.global-ai-assistant"),
                    ),
                    utf16("{\"x\":\"chào\"}"),
                ),
                (
                    entry("http://localhost:1420", latin1("politedb:welcome:seen")),
                    latin1("1"),
                ),
                (
                    entry("http://tauri.localhost", latin1("politedb.ai.endpoint")),
                    latin1("http://old"),
                ),
            ],
            &[
                (
                    entry(
                        "http://tauri.localhost",
                        latin1("politedb.pinned-connections.v1"),
                    ),
                    latin1(r#"{"pinnedIds":[]}"#),
                ),
                (
                    entry("http://tauri.localhost", latin1("politedb:welcome:seen")),
                    vec![7, 1],
                ),
            ],
        );
        fs::write(root.leveldb().join("LOCK"), b"").unwrap();
        let snapshot = |dir: &Path| {
            let mut files: Vec<_> = fs::read_dir(dir)
                .unwrap()
                .flatten()
                .map(|e| (e.file_name(), fs::read(e.path()).unwrap()))
                .collect();
            files.sort();
            files
        };
        let before = snapshot(&root.leveldb());

        let restored = read(&LegacyStore::Chromium {
            root: root.0.clone(),
            leveldb: root.leveldb(),
        })
        .unwrap();
        let mut entries = restored.entries.clone();
        entries.sort();
        assert_eq!(
            entries,
            vec![
                (
                    "politedb.ai.chat.global-ai-assistant".to_string(),
                    "{\"x\":\"chào\"}".to_string()
                ),
                (
                    "politedb.pinned-connections.v1".to_string(),
                    r#"{"pinnedIds":[]}"#.to_string()
                ),
                (
                    "politedb:app-settings:v1".to_string(),
                    r#"{"theme":"dark"}"#.to_string()
                ),
            ]
        );
        assert_eq!(restored.skipped, 1, "unknown value encoding");
        assert_eq!(before, snapshot(&root.leveldb()));
    }

    #[test]
    fn entry_names_require_the_exact_app_origin() {
        let name = latin1("k");
        assert!(app_entry_name(&entry("http://tauri.localhost", name.clone())).is_some());
        assert!(app_entry_name(&entry("https://tauri.localhost", name.clone())).is_some());
        for origin in [
            "http://tauri.localhost.evil",
            "http://tauri.localhos",
            "http://localhost:1420",
            "",
        ] {
            assert!(
                app_entry_name(&entry(origin, name.clone())).is_none(),
                "{origin}"
            );
        }
        assert!(app_entry_name(b"META:http://tauri.localhost").is_none());
        assert!(app_entry_name(b"_http://tauri.localhost").is_none());
    }

    #[test]
    fn corrupt_stores_are_errors() {
        let root = Root::new();
        fs::create_dir_all(root.leveldb()).unwrap();
        fs::write(root.leveldb().join("CURRENT"), b"MANIFEST-000009\n").unwrap();
        fs::write(root.leveldb().join("MANIFEST-000009"), b"garbage").unwrap();
        assert!(read(&LegacyStore::Chromium {
            root: root.0.clone(),
            leveldb: root.leveldb()
        })
        .is_err());

        let empty = Root::new();
        fs::create_dir_all(empty.leveldb()).unwrap();
        assert_eq!(
            read(&LegacyStore::Chromium {
                root: empty.0.clone(),
                leveldb: empty.leveldb()
            }),
            Err(ReadError::Open),
            "no CURRENT file: not created, not guessed"
        );
        let _ = Restored::default();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_store_folders_are_ignored() {
        use std::os::unix::fs::symlink;
        let real = Root::new();
        write_store(
            &real.leveldb(),
            &[(
                entry("http://tauri.localhost", latin1("politedb:welcome:seen")),
                latin1("1"),
            )],
            &[],
        );
        let root = Root::new();
        symlink(real.leveldb(), root.leveldb()).unwrap();
        assert_eq!(
            read(&LegacyStore::Chromium {
                root: root.0.clone(),
                leveldb: root.leveldb(),
            }),
            Ok(Restored::default())
        );
    }
}
