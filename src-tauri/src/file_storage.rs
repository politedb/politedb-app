use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

// Root folders / files under app_data_dir
const PERSISTENT_DIR: &str = "persistent";
const PERSISTENT_UI_FILE: &str = "ui.json";
const LICENSE_DIR: &str = "license";
const LICENSE_FILE: &str = "state.json";
const AI_DIR: &str = "ai";
const AI_PROVIDERS_FILE: &str = "providers.json";

const PROFILES_DIR: &str = "profiles";
const PROFILES_FILE: &str = "profiles.json";

const DRAFTS_DIR: &str = "drafts";
const SQL_DRAFTS_DIR: &str = "sql";

const SNIPPETS_DIR: &str = "snippets";
const SNIPPETS_LIBRARY_FILE: &str = "library.json";

fn app_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app_data_dir: {e}"))
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path (no parent)".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    Ok(())
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    ensure_parent_dir(path)?;

    // Use a deterministic temp path in the same directory (atomic rename on same FS)
    let tmp_path = path.with_extension("tmp");

    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("Create tmp failed: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("Write tmp failed: {e}"))?;
        f.sync_all().map_err(|e| format!("Sync tmp failed: {e}"))?;
    }

    // Windows: rename over existing can fail → remove first
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Remove old failed: {e}"))?;
    }

    fs::rename(&tmp_path, path).map_err(|e| format!("Rename tmp failed: {e}"))?;
    Ok(())
}

fn read_bytes_if_exists(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| format!("Read failed: {e}"))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(bytes))
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Remove file failed: {e}"))?;
    }
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Path API (single source of truth)                                          */
/* -------------------------------------------------------------------------- */

pub fn path_persistent_ui(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?
        .join(PERSISTENT_DIR)
        .join(PERSISTENT_UI_FILE))
}

pub fn path_profiles(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join(PROFILES_DIR).join(PROFILES_FILE))
}

pub fn path_license_state(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join(LICENSE_DIR).join(LICENSE_FILE))
}

pub fn path_ai_providers(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join(AI_DIR).join(AI_PROVIDERS_FILE))
}

pub fn dir_sql_drafts(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join(DRAFTS_DIR).join(SQL_DRAFTS_DIR))
}

pub fn path_sql_draft(app: &tauri::AppHandle, draft_id: &str) -> Result<PathBuf, String> {
    // draft_id should be safe for filenames (windowId/tabId); caller responsibility.
    Ok(dir_sql_drafts(app)?.join(format!("{draft_id}.sql")))
}

pub fn path_snippets_library(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?
        .join(SNIPPETS_DIR)
        .join(SNIPPETS_LIBRARY_FILE))
}

/* -------------------------------------------------------------------------- */
/* JSON helpers                                                               */
/* -------------------------------------------------------------------------- */

pub fn json_write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| format!("Serialize JSON failed: {e}"))?;
    atomic_write_bytes(path, &bytes)
}

/// Atomically replaces `dst` with `src`; the previous `dst` survives any failure.
#[cfg(not(windows))]
fn replace_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::rename(src, dst)
}

/// Windows: `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` so the replacement is flushed
/// before returning (plan R11).
#[cfg(windows)]
fn replace_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (src_w, dst_w) = (wide(src), wide(dst));
    // SAFETY: both paths are NUL-terminated wide strings that outlive the call.
    unsafe {
        MoveFileExW(
            PCWSTR(src_w.as_ptr()),
            PCWSTR(dst_w.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|e| std::io::Error::from_raw_os_error(e.code().0 & 0xFFFF))
}

/// Writes `value` by replacing the destination in one step, so a failed write or crash
/// leaves the previous file intact (no remove-then-rename window).
pub fn json_replace_preserving<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| format!("Serialize JSON failed: {e}"))?;
    ensure_parent_dir(path)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Invalid path (no file name)".to_string())?
        .to_string_lossy();
    let tmp_path = path.with_file_name(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let write = || -> Result<(), String> {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("Create tmp failed: {e}"))?;
        f.write_all(&bytes)
            .map_err(|e| format!("Write tmp failed: {e}"))?;
        f.sync_all().map_err(|e| format!("Sync tmp failed: {e}"))?;
        drop(f);
        replace_file(&tmp_path, path).map_err(|e| format!("Replace failed: {e}"))
    };
    let result = write();
    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

pub fn json_read_if_exists<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let Some(bytes) = read_bytes_if_exists(path)? else {
        return Ok(None);
    };
    let value =
        serde_json::from_slice::<T>(&bytes).map_err(|e| format!("Parse JSON failed: {e}"))?;
    Ok(Some(value))
}

/* -------------------------------------------------------------------------- */
/* Text helpers (SQL drafts)                                                  */
/* -------------------------------------------------------------------------- */

pub fn text_write_atomic(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, content.as_bytes())
}

pub fn text_read_if_exists(path: &Path) -> Result<Option<String>, String> {
    let Some(bytes) = read_bytes_if_exists(path)? else {
        return Ok(None);
    };
    let s = String::from_utf8(bytes).map_err(|e| format!("Invalid UTF-8: {e}"))?;
    Ok(Some(s))
}

/* -------------------------------------------------------------------------- */
/* Remove helpers                                                             */
/* -------------------------------------------------------------------------- */

pub fn remove_if_exists(path: &Path) -> Result<(), String> {
    remove_file_if_exists(path)
}

/* -------------------------------------------------------------------------- */
/* Export: append to file (for streaming export; path is from dialog)         */
/* -------------------------------------------------------------------------- */

pub fn export_append_to_file(path: &Path, content: &str, append: &bool) -> Result<(), String> {
    use std::fs::OpenOptions;
    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .append(*append)
        .truncate(!*append)
        .open(path)
        .map_err(|e| format!("Open/append failed: {e}"))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("Write failed: {e}"))?;
    f.sync_all().map_err(|e| format!("Sync failed: {e}"))?;
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Export sessions: exclusive temp sibling + publish / discard                */
/* -------------------------------------------------------------------------- */

/// Marker suffix for PoliteDB export temp files (session-owned only).
pub const EXPORT_TEMP_SUFFIX: &str = ".politedb-export.tmp";

pub fn export_temp_sibling_path(final_path: &Path, session_token: &str) -> Result<PathBuf, String> {
    let file_name = final_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid export path".to_string())?;
    let parent = final_path
        .parent()
        .ok_or_else(|| "Invalid export path (no parent)".to_string())?;
    let token: String = session_token
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if token.is_empty() {
        return Err("Invalid export session token".to_string());
    }
    let temp_name = format!("{file_name}.{token}{EXPORT_TEMP_SUFFIX}");
    Ok(parent.join(temp_name))
}

pub fn is_export_temp_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.contains(EXPORT_TEMP_SUFFIX))
        .unwrap_or(false)
}

/// Create an exclusive empty temp sibling. Does not touch final_path.
pub fn export_create_temp(final_path: &Path, session_token: &str) -> Result<PathBuf, String> {
    ensure_parent_dir(final_path)?;
    let temp = export_temp_sibling_path(final_path, session_token)?;
    if temp.exists() {
        return Err("Export temp path already exists".to_string());
    }
    use std::fs::OpenOptions;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("Create export temp failed: {e}"))?;
    Ok(temp)
}

/// Discard only a recognized PoliteDB export temp path. Never deletes arbitrary paths.
pub fn export_discard_temp(temp_path: &Path) -> Result<(), String> {
    if !is_export_temp_path(temp_path) {
        return Err("Refusing to delete non-export temp path".to_string());
    }
    remove_file_if_exists(temp_path)
}

/// Atomically replace `final_path` with `temp_path` when the destination exists.
/// Keeps the existing destination intact if replacement fails (no park-then-rename).
fn export_replace_atomic(temp_path: &Path, final_path: &Path) -> Result<(), String> {
    if !final_path.exists() {
        return fs::rename(temp_path, final_path)
            .map_err(|e| format!("Publish export failed: {e}"));
    }

    #[cfg(unix)]
    {
        // rename(2) replaces the destination atomically on the same filesystem.
        // The previous inode remains reachable until the syscall returns, so a
        // crash cannot leave the destination path missing.
        fs::rename(temp_path, final_path).map_err(|e| format!("Publish export failed: {e}"))
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS};

        fn wide(path: &Path) -> Vec<u16> {
            path.as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }

        let replaced = wide(final_path);
        let replacement = wide(temp_path);
        // ReplaceFileW swaps in the new file without a window where the
        // destination path is absent; on failure the original remains.
        let ok = unsafe {
            ReplaceFileW(
                PCWSTR(replaced.as_ptr()),
                PCWSTR(replacement.as_ptr()),
                PCWSTR::null(),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        };
        match ok {
            Ok(()) => Ok(()),
            Err(e) => Err(format!("Publish export failed: {e}")),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err("Atomic export replace is unsupported on this platform".to_string())
    }
}

/// Publish temp over final. Preserves existing destination if replacement fails.
pub fn export_publish_temp(temp_path: &Path, final_path: &Path) -> Result<(), String> {
    if !is_export_temp_path(temp_path) {
        return Err("Refusing to publish non-export temp path".to_string());
    }
    if !temp_path.exists() {
        return Err("Export temp missing".to_string());
    }
    {
        use std::fs::OpenOptions;
        let f = OpenOptions::new()
            .write(true)
            .open(temp_path)
            .map_err(|e| format!("Open export temp failed: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("Sync export temp failed: {e}"))?;
    }

    export_replace_atomic(temp_path, final_path)
}

#[cfg(test)]
mod export_session_tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn discard_refuses_arbitrary_paths() {
        let dir = std::env::temp_dir().join(format!("politedb-fs-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("important.csv");
        fs::write(&victim, b"keep").unwrap();
        assert!(export_discard_temp(&victim).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn publish_preserves_destination_on_missing_temp() {
        let dir = std::env::temp_dir().join(format!("politedb-fs-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("out.csv");
        fs::write(&final_path, b"ORIGINAL").unwrap();
        let fake_temp = dir.join(format!("out.csv.tok{EXPORT_TEMP_SUFFIX}"));
        assert!(export_publish_temp(&fake_temp, &final_path).is_err());
        assert_eq!(fs::read_to_string(&final_path).unwrap(), "ORIGINAL");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn publish_preserves_destination_on_replace_failure() {
        let dir = std::env::temp_dir().join(format!("politedb-fs-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("out.csv");
        fs::write(&final_path, b"ORIGINAL").unwrap();
        let temp = export_create_temp(&final_path, "tok").unwrap();
        fs::write(&temp, b"NEW").unwrap();

        // After preflight (temp exists + synced), force replacement to fail by
        // making the directory non-writable. Destination must remain untouched.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&dir).unwrap().permissions();
            perms.set_mode(0o555);
            fs::set_permissions(&dir, perms).unwrap();
        }
        #[cfg(not(unix))]
        {
            let mut perms = fs::metadata(&dir).unwrap().permissions();
            perms.set_readonly(true);
            fs::set_permissions(&dir, perms).unwrap();
        }

        let result = export_publish_temp(&temp, &final_path);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&dir).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&dir, perms).unwrap();
        }
        #[cfg(not(unix))]
        {
            let mut perms = fs::metadata(&dir).unwrap().permissions();
            perms.set_readonly(false);
            fs::set_permissions(&dir, perms).unwrap();
        }

        assert!(result.is_err(), "expected replace failure, got {result:?}");
        assert_eq!(fs::read_to_string(&final_path).unwrap(), "ORIGINAL");
        assert!(temp.exists(), "temp should remain when replace fails");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn publish_replaces_existing_destination_atomically() {
        let dir = std::env::temp_dir().join(format!("politedb-fs-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("out.csv");
        fs::write(&final_path, b"ORIGINAL").unwrap();
        let temp = export_create_temp(&final_path, "tok").unwrap();
        fs::write(&temp, b"NEWDATA").unwrap();
        export_publish_temp(&temp, &final_path).unwrap();
        assert_eq!(fs::read_to_string(&final_path).unwrap(), "NEWDATA");
        assert!(!temp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_preserving_overwrites_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("politedb-replace-{}", uuid::Uuid::new_v4()));
        let path = dir.join("providers.json");
        json_replace_preserving(&path, &vec![1]).unwrap();
        json_replace_preserving(&path, &vec![2]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[2]");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn replace_preserving_keeps_previous_file_when_write_fails() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("politedb-replace-{}", uuid::Uuid::new_v4()));
        let path = dir.join("providers.json");
        json_replace_preserving(&path, &vec![1]).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let result = json_replace_preserving(&path, &vec![2]);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn replace_preserving_keeps_previous_bytes_when_replacement_fails() {
        let dir = std::env::temp_dir().join(format!("politedb-replace-{}", uuid::Uuid::new_v4()));
        let path = dir.join("providers.json");
        json_replace_preserving(&path, &vec![1]).unwrap();
        // A read-only destination makes MoveFileExW(REPLACE_EXISTING) fail.
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms.clone()).unwrap();
        let result = json_replace_preserving(&path, &vec![2]);
        perms.set_readonly(false);
        fs::set_permissions(&path, perms).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "temp file cleaned up"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
