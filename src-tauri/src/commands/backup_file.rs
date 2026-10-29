//! Thin commands for backup files (see `backup_file`).

use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request};
use uuid::Uuid;

use crate::backup_file::{backup_files, NOT_FOUND};

#[tauri::command]
pub fn backup_file_begin(path: String) -> Result<Uuid, String> {
    backup_files().begin(PathBuf::from(path))
}

/// The bytes come as the raw request body (no JSON number array for a
/// large backup), the session id in the `x-session-id` header.
#[tauri::command]
pub fn backup_file_write(request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or(NOT_FOUND)?;
    match request.body() {
        InvokeBody::Raw(bytes) => backup_files().write(id, bytes),
        InvokeBody::Json(_) => Err("BACKUP_FILE_BODY_INVALID".into()),
    }
}

#[tauri::command]
pub fn backup_file_publish(session_id: Uuid) -> Result<(), String> {
    backup_files().publish(session_id)
}

#[tauri::command]
pub fn backup_file_abort(session_id: Uuid) -> Result<(), String> {
    backup_files().abort(session_id)
}

#[tauri::command]
pub fn backup_file_forget(session_id: Uuid) -> Result<(), String> {
    backup_files().forget(session_id)
}
