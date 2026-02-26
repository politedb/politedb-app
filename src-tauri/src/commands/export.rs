use std::path::Path;

use crate::file_storage;

/// Appends content to a file at the given path.
/// Path should be from the dialog plugin (user-selected save location).
#[tauri::command]
pub fn export_append_to_file(path: String, content: String, append: bool) -> Result<(), String> {
    file_storage::export_append_to_file(Path::new(&path), &content, &append)
}
