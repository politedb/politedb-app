//! WebKit localStorage (macOS WKWebView, Linux WebKitGTK).
//!
//! Current layout: `<general>/<hash>/<hash>/origin` names the origin and
//! `LocalStorage/localstorage.sqlite3` (+ `-wal`/`-shm`) holds the data. Older WebKit
//! keeps one flat `<scheme>_<host>_<port>.localstorage` file per origin. Both use
//! `ItemTable(key TEXT, value BLOB)` with UTF-16LE values.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use super::{
    copy_files, is_real_dir, is_real_file, utf16le, ReadError, ScratchDir, MAX_STORE_BYTES,
};

const SCHEME: &[u8] = b"tauri";
const HOST: &[u8] = b"localhost";
const FLAT_FILE: &str = "tauri_localhost_0.localstorage";
const DATABASE: &str = "localstorage.sqlite3";

/// The app's localStorage database in the old store, if any. `general` and `flat`
/// are `None` when they are missing or reached through a symlink. More than one
/// `tauri://localhost` origin folder is ambiguous and never guessed.
pub fn find_database(
    general: Option<&Path>,
    flat: Option<&Path>,
) -> Result<Option<PathBuf>, ReadError> {
    let mut found = Vec::new();
    if let Some(general) = general {
        for entry in fs::read_dir(general)
            .map_err(|_| ReadError::Open)?
            .flatten()
        {
            let outer = entry.path();
            if !is_real_dir(&outer) {
                continue;
            }
            let inner = outer.join(entry.file_name());
            if !is_real_dir(&inner) {
                continue;
            }
            let origin = inner.join("origin");
            if !is_real_file(&origin) {
                continue;
            }
            let Ok(bytes) = fs::read(&origin) else {
                continue;
            };
            let local_storage = inner.join("LocalStorage");
            let database = local_storage.join(DATABASE);
            if is_app_origin(&bytes) && is_real_dir(&local_storage) && is_real_file(&database) {
                found.push(database);
            }
        }
    }
    match found.len() {
        0 => {}
        1 => return Ok(found.pop()),
        _ => return Err(ReadError::Ambiguous),
    }
    let Some(flat) = flat else {
        return Ok(None);
    };
    let flat_file = flat.join(FLAT_FILE);
    Ok(is_real_file(&flat_file).then_some(flat_file))
}

/// An `origin` file holds the top-frame and frame origins, each as protocol, host
/// (`u32` LE length, `u8` 1 = Latin-1 / 0 = UTF-16, bytes) and port (`u8` 0 = none,
/// or 1 + `u16` LE). Only `tauri://localhost` twice, with nothing after, is the app.
pub fn is_app_origin(bytes: &[u8]) -> bool {
    let mut rest = bytes;
    for _ in 0..2 {
        let Some((scheme, after)) = read_string(rest) else {
            return false;
        };
        let Some((host, after)) = read_string(after) else {
            return false;
        };
        // No port.
        let Some((&0, after)) = after.split_first() else {
            return false;
        };
        if scheme != SCHEME || host != HOST {
            return false;
        }
        rest = after;
    }
    rest.is_empty()
}

/// A Latin-1 string; UTF-16 strings never match the ASCII origin, so they are
/// rejected as well.
fn read_string(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let len = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let (&latin1, rest) = bytes.get(4..)?.split_first()?;
    if latin1 != 1 || rest.len() < len {
        return None;
    }
    Some(rest.split_at(len))
}

/// All rows of a localStorage database, read from a private copy (the WAL holds
/// recent writes, so it is copied too), and how many could not be decoded.
pub fn read_items(database: &Path) -> Result<(Vec<(String, String)>, usize), ReadError> {
    let scratch = ScratchDir::new()?;
    let mut budget = MAX_STORE_BYTES;
    let with_suffix = |suffix: &str| {
        let mut name = database.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    copy_files(
        &[
            (database.to_path_buf(), true),
            (with_suffix("-wal"), false),
            (with_suffix("-shm"), false),
        ],
        scratch.path(),
        &mut budget,
    )?;
    let copy = scratch
        .path()
        .join(database.file_name().ok_or(ReadError::Copy)?);
    let conn = Connection::open_with_flags(
        &copy,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ReadError::Open)?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM ItemTable")
        .map_err(|_| ReadError::Query)?;
    let mut rows = stmt.query([]).map_err(|_| ReadError::Query)?;
    let mut items = Vec::new();
    let mut invalid = 0;
    while let Some(row) = rows.next().map_err(|_| ReadError::Query)? {
        let key = match row.get_ref(0) {
            Ok(ValueRef::Text(t)) => std::str::from_utf8(t).ok().map(str::to_string),
            _ => None,
        };
        let value = match row.get_ref(1) {
            Ok(ValueRef::Blob(b)) => utf16le(b),
            _ => None,
        };
        match (key, value) {
            (Some(key), Some(value)) => items.push((key, value)),
            (Some(key), None) if super::is_allowed(&key) => invalid += 1,
            _ => {}
        }
    }
    Ok((items, invalid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy_web_storage::{read, LegacyStore, Restored};

    /// Bytes of an `origin` file for `scheme://host[:port]`, twice.
    pub fn origin_bytes(scheme: &str, host: &str, port: Option<u16>) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..2 {
            for part in [scheme, host] {
                out.extend((part.len() as u32).to_le_bytes());
                out.push(1);
                out.extend(part.as_bytes());
            }
            match port {
                None => out.push(0),
                Some(p) => {
                    out.push(1);
                    out.extend(p.to_le_bytes());
                }
            }
        }
        out
    }

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("politedb-webkit-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn store(&self) -> LegacyStore {
            LegacyStore::WebKit {
                root: self.0.clone(),
                general: self.0.join("Default"),
                flat: self.0.join("LocalStorage"),
            }
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Creates an origin folder with a WAL-mode database holding `rows`. Rows are
    /// left in the WAL (the connection is leaked open so no checkpoint runs).
    fn origin_folder(
        root: &Path,
        hash: &str,
        origin: &[u8],
        rows: &[(&str, Vec<u8>)],
    ) -> (PathBuf, Connection) {
        let inner = root.join("Default").join(hash).join(hash);
        fs::create_dir_all(inner.join("LocalStorage")).unwrap();
        fs::write(inner.join("origin"), origin).unwrap();
        let database = inner.join("LocalStorage").join(DATABASE);
        let conn = Connection::open(&database).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE,
                                     value BLOB NOT NULL ON CONFLICT FAIL);",
        )
        .unwrap();
        for (key, value) in rows {
            conn.execute(
                "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value],
            )
            .unwrap();
        }
        (database, conn)
    }

    #[test]
    fn origin_parsing_is_exact() {
        assert!(is_app_origin(&origin_bytes("tauri", "localhost", None)));
        assert!(!is_app_origin(&origin_bytes(
            "http",
            "localhost",
            Some(1420)
        )));
        assert!(!is_app_origin(&origin_bytes("tauri", "localhost", Some(1))));
        assert!(!is_app_origin(&origin_bytes("tauri", "localhostx", None)));
        let mut extra = origin_bytes("tauri", "localhost", None);
        extra.push(0);
        assert!(!is_app_origin(&extra));
        let full = origin_bytes("tauri", "localhost", None);
        for cut in 0..full.len() {
            assert!(!is_app_origin(&full[..cut]), "{cut}");
        }
        // Exact bytes observed in a real 1.4 store (Phase 0).
        let real = [
            0x05, 0, 0, 0, 1, b't', b'a', b'u', b'r', b'i', 0x09, 0, 0, 0, 1, b'l', b'o', b'c',
            b'a', b'l', b'h', b'o', b's', b't', 0, 0x05, 0, 0, 0, 1, b't', b'a', b'u', b'r', b'i',
            0x09, 0, 0, 0, 1, b'l', b'o', b'c', b'a', b'l', b'h', b'o', b's', b't', 0,
        ];
        assert!(is_app_origin(&real));
        // A UTF-16 encoded string is never accepted.
        let mut utf16_scheme = vec![5, 0, 0, 0, 0];
        utf16_scheme.extend(utf16("tauri"));
        assert!(!is_app_origin(&utf16_scheme));
    }

    #[test]
    fn reads_the_tauri_origin_including_wal_rows_and_leaves_the_source_alone() {
        let root = Root::new();
        let (database, _keep_open) = origin_folder(
            &root.0,
            "aaa",
            &origin_bytes("tauri", "localhost", None),
            &[
                ("politedb:app-settings:v1", utf16(r#"{"theme":"dark"}"#)),
                (
                    "politedb.ai.chat.global-ai-assistant",
                    utf16("{\"x\":\"chào\"}"),
                ),
                ("politedb.ai.endpoint", utf16("http://old")),
                ("politedb.pinned-connections.v1", vec![0x41]), // odd length: invalid
            ],
        );
        let (_dev, _dev_open) = origin_folder(
            &root.0,
            "bbb",
            &origin_bytes("http", "localhost", Some(1420)),
            &[("politedb:welcome:seen", utf16("1"))],
        );
        let wal = PathBuf::from(format!("{}-wal", database.display()));
        assert!(
            fs::metadata(&wal).unwrap().len() > 0,
            "rows live in the WAL"
        );
        let before: Vec<_> = [&database, &wal]
            .iter()
            .map(|p| fs::read(p).unwrap())
            .collect();

        let restored = read(&root.store()).unwrap();
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
                    "politedb:app-settings:v1".to_string(),
                    r#"{"theme":"dark"}"#.to_string()
                ),
            ]
        );
        assert_eq!(restored.skipped, 1);
        let after: Vec<_> = [&database, &wal]
            .iter()
            .map(|p| fs::read(p).unwrap())
            .collect();
        assert_eq!(before, after);
    }

    #[test]
    fn two_app_origins_are_ambiguous() {
        let root = Root::new();
        let origin = origin_bytes("tauri", "localhost", None);
        let row = [("politedb:welcome:seen", utf16("1"))];
        let _a = origin_folder(&root.0, "aaa", &origin, &row);
        let _b = origin_folder(&root.0, "bbb", &origin, &row);
        assert_eq!(read(&root.store()), Err(ReadError::Ambiguous));
    }

    #[test]
    fn no_app_origin_is_empty() {
        let root = Root::new();
        let _dev = origin_folder(
            &root.0,
            "bbb",
            &origin_bytes("http", "localhost", Some(1420)),
            &[("politedb:welcome:seen", utf16("1"))],
        );
        assert_eq!(read(&root.store()), Ok(Restored::default()));
    }

    #[test]
    fn reads_the_flat_layout() {
        let root = Root::new();
        let flat = root.0.join("LocalStorage");
        fs::create_dir_all(&flat).unwrap();
        let conn = Connection::open(flat.join(FLAT_FILE)).unwrap();
        conn.execute_batch("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL);").unwrap();
        conn.execute(
            "INSERT INTO ItemTable VALUES ('politedb:welcome:seen', ?1)",
            [utf16("1")],
        )
        .unwrap();
        drop(conn);
        // Other origins' flat files are ignored.
        fs::write(flat.join("http_localhost_1420.localstorage"), b"x").unwrap();
        let restored = read(&root.store()).unwrap();
        assert_eq!(
            restored.entries,
            vec![("politedb:welcome:seen".to_string(), "1".to_string())]
        );
    }

    #[test]
    fn corrupt_databases_are_errors() {
        let root = Root::new();
        let inner = root.0.join("Default/aaa/aaa");
        fs::create_dir_all(inner.join("LocalStorage")).unwrap();
        fs::write(
            inner.join("origin"),
            origin_bytes("tauri", "localhost", None),
        )
        .unwrap();
        fs::write(inner.join("LocalStorage").join(DATABASE), b"not a database").unwrap();
        assert!(matches!(
            read(&root.store()),
            Err(ReadError::Open | ReadError::Query)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folders_and_files_are_ignored() {
        use std::os::unix::fs::symlink;
        let root = Root::new();
        let real = Root::new();
        let _ = origin_folder(
            &real.0,
            "aaa",
            &origin_bytes("tauri", "localhost", None),
            &[("politedb:welcome:seen", utf16("1"))],
        );
        fs::create_dir_all(root.0.join("Default")).unwrap();
        symlink(real.0.join("Default/aaa"), root.0.join("Default/aaa")).unwrap();
        assert_eq!(read(&root.store()), Ok(Restored::default()));

        let flat = root.0.join("LocalStorage");
        fs::create_dir_all(&flat).unwrap();
        symlink(
            real.0.join("Default/aaa/aaa/LocalStorage").join(DATABASE),
            flat.join(FLAT_FILE),
        )
        .unwrap();
        assert_eq!(read(&root.store()), Ok(Restored::default()));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_parent_folders_are_ignored() {
        use std::os::unix::fs::symlink;
        let real = Root::new();
        let (database, _keep_open) = origin_folder(
            &real.0,
            "aaa",
            &origin_bytes("tauri", "localhost", None),
            &[("politedb:welcome:seen", utf16("1"))],
        );
        let outside = database.parent().unwrap();

        // `inner/LocalStorage` is a symlink to a real database folder elsewhere.
        let root = Root::new();
        let inner = root.0.join("Default/aaa/aaa");
        fs::create_dir_all(&inner).unwrap();
        fs::write(
            inner.join("origin"),
            origin_bytes("tauri", "localhost", None),
        )
        .unwrap();
        symlink(outside, inner.join("LocalStorage")).unwrap();
        assert_eq!(read(&root.store()), Ok(Restored::default()));

        // The whole flat-layout folder is a symlink.
        let flat_root = Root::new();
        let elsewhere = Root::new();
        fs::copy(&database, elsewhere.0.join(FLAT_FILE)).unwrap();
        symlink(&elsewhere.0, flat_root.0.join("LocalStorage")).unwrap();
        assert_eq!(read(&flat_root.store()), Ok(Restored::default()));

        // The general folder, or the store root itself, is a symlink.
        let linked = Root::new();
        symlink(real.0.join("Default"), linked.0.join("Default")).unwrap();
        assert_eq!(read(&linked.store()), Ok(Restored::default()));
        let parent = Root::new();
        let link = parent.0.join("com.politehq.politedb");
        symlink(&real.0, &link).unwrap();
        let store = LegacyStore::WebKit {
            root: link.clone(),
            general: link.join("Default"),
            flat: link.join("LocalStorage"),
        };
        assert_eq!(read(&store), Ok(Restored::default()));
        // Sanity: the real store itself is readable.
        assert_eq!(read(&real.store()).unwrap().entries.len(), 1);
    }
}
