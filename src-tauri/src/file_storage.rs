use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

// Root folders / files under app_data_dir
const PERSISTENT_DIR: &str = "persistent";
const PERSISTENT_UI_FILE: &str = "ui.json";

const PROFILES_DIR: &str = "profiles";
const PROFILES_FILE: &str = "profiles.json";

const DRAFTS_DIR: &str = "drafts";
const SQL_DRAFTS_DIR: &str = "sql";

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

pub fn dir_sql_drafts(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join(DRAFTS_DIR).join(SQL_DRAFTS_DIR))
}

pub fn path_sql_draft(app: &tauri::AppHandle, draft_id: &str) -> Result<PathBuf, String> {
    // draft_id should be safe for filenames (windowId/tabId); caller responsibility.
    Ok(dir_sql_drafts(app)?.join(format!("{draft_id}.sql")))
}

/* -------------------------------------------------------------------------- */
/* JSON helpers                                                               */
/* -------------------------------------------------------------------------- */

pub fn json_write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| format!("Serialize JSON failed: {e}"))?;
    atomic_write_bytes(path, &bytes)
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
