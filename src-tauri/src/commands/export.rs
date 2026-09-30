use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use uuid::Uuid;

use crate::file_storage;

struct ExportSession {
    final_path: PathBuf,
    temp_path: PathBuf,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, ExportSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionBeginResult {
    pub session_id: String,
}

fn sanitize(msg: &str) -> String {
    msg.to_string()
}

/// Begin a scoped export session. Writes go to an exclusive temp sibling of `path`.
#[tauri::command]
pub fn export_session_begin(path: String) -> Result<ExportSessionBeginResult, String> {
    let final_path = PathBuf::from(&path);
    if final_path.as_os_str().is_empty() {
        return Err(sanitize("Export path is required"));
    }

    let session_id = Uuid::new_v4().to_string();
    let temp_path = file_storage::export_create_temp(&final_path, &session_id)
        .map_err(|_| sanitize("Failed to create export temp file"))?;

    let mut guard = SESSIONS
        .lock()
        .map_err(|_| sanitize("Export session lock failed"))?;
    guard.insert(
        session_id.clone(),
        ExportSession {
            final_path,
            temp_path,
        },
    );

    Ok(ExportSessionBeginResult { session_id })
}

/// Append transformed content to the session temp file only.
#[tauri::command]
pub fn export_session_append(session_id: String, content: String) -> Result<(), String> {
    let guard = SESSIONS
        .lock()
        .map_err(|_| sanitize("Export session lock failed"))?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| sanitize("Export session not found"))?;

    file_storage::export_append_to_file(&session.temp_path, &content, &true)
        .map_err(|_| sanitize("Export write failed"))
}

/// Flush/close temp and publish to the final path. Preserves existing destination on failure.
#[tauri::command]
pub fn export_session_publish(session_id: String) -> Result<(), String> {
    let mut guard = SESSIONS
        .lock()
        .map_err(|_| sanitize("Export session lock failed"))?;
    let session = guard
        .remove(&session_id)
        .ok_or_else(|| sanitize("Export session not found"))?;

    match file_storage::export_publish_temp(&session.temp_path, &session.final_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = file_storage::export_discard_temp(&session.temp_path);
            Err(sanitize("Failed to publish export file"))
        }
    }
}

/// Abort: delete only the session-owned temp file. Never deletes the final path.
#[tauri::command]
pub fn export_session_abort(session_id: String) -> Result<(), String> {
    let mut guard = SESSIONS
        .lock()
        .map_err(|_| sanitize("Export session lock failed"))?;
    if let Some(session) = guard.remove(&session_id) {
        let _ = file_storage::export_discard_temp(&session.temp_path);
    }
    Ok(())
}

/// Legacy direct append (compatibility). Prefer session APIs for new exports.
#[tauri::command]
pub fn export_append_to_file(path: String, content: String, append: bool) -> Result<(), String> {
    file_storage::export_append_to_file(Path::new(&path), &content, &append)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn session_publish_preserves_destination_on_abort() {
        let dir = std::env::temp_dir().join(format!("politedb-export-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("out.csv");
        fs::write(&final_path, b"ORIGINAL").unwrap();

        let began = export_session_begin(final_path.to_string_lossy().to_string()).unwrap();
        export_session_append(began.session_id.clone(), "NEW".into()).unwrap();
        export_session_abort(began.session_id).unwrap();

        let body = fs::read_to_string(&final_path).unwrap();
        assert_eq!(body, "ORIGINAL");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_publish_replaces_only_after_success() {
        let dir = std::env::temp_dir().join(format!("politedb-export-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("out.csv");
        fs::write(&final_path, b"ORIGINAL").unwrap();

        let began = export_session_begin(final_path.to_string_lossy().to_string()).unwrap();
        export_session_append(began.session_id.clone(), "header\nrow\n".into()).unwrap();
        export_session_publish(began.session_id).unwrap();

        let body = fs::read_to_string(&final_path).unwrap();
        assert_eq!(body, "header\nrow\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn abort_unknown_session_is_ok() {
        export_session_abort("missing".into()).unwrap();
    }
}
