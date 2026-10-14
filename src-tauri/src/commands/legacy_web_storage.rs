//! Restores localStorage left by builds before the 1.5 identifier change
//! (plan legacy-webkit-storage). Logic lives in `crate::legacy_web_storage`.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::distribution::Distribution;
use crate::legacy_web_storage::{self, Restored};

pub const LEGACY_STORAGE_UNREADABLE: &str = "LEGACY_STORAGE_UNREADABLE";

#[derive(Debug, Serialize)]
pub struct LegacyEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Default, Serialize)]
pub struct LegacyWebStorage {
    pub entries: Vec<LegacyEntry>,
    pub skipped: usize,
}

impl From<Restored> for LegacyWebStorage {
    fn from(restored: Restored) -> Self {
        Self {
            entries: restored
                .entries
                .into_iter()
                .map(|(key, value)| LegacyEntry { key, value })
                .collect(),
            skipped: restored.skipped,
        }
    }
}

/// The allowlisted localStorage entries of the pre-1.5 store, or none when there is
/// no such store. The frontend writes only the keys it does not have yet.
#[tauri::command]
pub async fn legacy_web_storage_read(app: AppHandle) -> Result<LegacyWebStorage, String> {
    if !Distribution::current().supports_legacy_web_storage_import() {
        return Ok(LegacyWebStorage::default());
    }
    let paths = app.path();
    let Some(store) = legacy_web_storage::legacy_store(
        paths.home_dir().ok().as_deref(),
        paths.local_data_dir().ok().as_deref(),
    ) else {
        return Ok(LegacyWebStorage::default());
    };
    let result = tauri::async_runtime::spawn_blocking(move || legacy_web_storage::read(&store))
        .await
        .map_err(|_| LEGACY_STORAGE_UNREADABLE.to_string())?;
    match result {
        Ok(restored) => {
            if !restored.entries.is_empty() || restored.skipped > 0 {
                tracing::info!(
                    entries = restored.entries.len(),
                    skipped = restored.skipped,
                    "read legacy web storage"
                );
            }
            Ok(restored.into())
        }
        Err(error) => {
            tracing::warn!(kind = error.kind(), "legacy web storage unreadable");
            Err(LEGACY_STORAGE_UNREADABLE.into())
        }
    }
}
