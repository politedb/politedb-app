use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle};

use crate::file_storage as storage;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnippetLibraryFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub folders: Vec<SnippetFolderRecord>,
    #[serde(default)]
    pub snippets: Vec<SavedSnippetRecord>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetFolderRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub scope: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSnippetRecord {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    pub scope: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub hotkey: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default)]
    pub sort_order: i64,
}

#[command]
pub fn snippets_load(app: AppHandle) -> Result<SnippetLibraryFile, String> {
    let path = storage::path_snippets_library(&app)?;
    Ok(storage::json_read_if_exists::<SnippetLibraryFile>(&path)?.unwrap_or_default())
}

#[command]
pub fn snippets_save(app: AppHandle, library: SnippetLibraryFile) -> Result<(), String> {
    let path = storage::path_snippets_library(&app)?;
    storage::json_write_atomic(&path, &library)
}
