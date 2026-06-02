use serde::Deserialize;
use tauri::AppHandle;

use crate::profiles::import_external::{self, ExternalImportResult};
use crate::profiles::store as profile_store;
use crate::profiles::types::ConnectionProfile;

use super::types::{ProfileExportFile, ProfileImportPayload, ProfileImportResult};

#[tauri::command]
pub fn profile_import(
    app: AppHandle,
    payload: ProfileImportPayload,
) -> Result<ProfileImportResult, String> {
    let json = payload.json.trim();
    if json.is_empty() {
        return Err("PROFILE_IMPORT_EMPTY".into());
    }

    let profiles = match serde_json::from_str::<ProfileExportFile>(json) {
        Ok(file) => file.profiles,
        Err(wrapper_err) => match serde_json::from_str::<Vec<ConnectionProfile>>(json) {
            Ok(list) => list,
            Err(list_err) => match serde_json::from_str::<ConnectionProfile>(json) {
                Ok(profile) => vec![profile],
                Err(one_err) => {
                    return Err(format!(
                        "PROFILE_IMPORT_INVALID_JSON: wrapper={wrapper_err}; list={list_err}; one={one_err}"
                    ))
                }
            },
        },
    };

    let (created, updated, profiles) = profile_store::profile_upsert_many(&app, profiles)?;
    let total = profiles.len();

    Ok(ProfileImportResult {
        created,
        updated,
        total,
        profiles,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileImportExternalPayload {
    pub path: String,
    pub password: Option<String>,
}

#[tauri::command]
pub fn profile_import_external(
    app: AppHandle,
    payload: ProfileImportExternalPayload,
) -> Result<ExternalImportResult, String> {
    import_external::import_external_file(&app, &payload.path, payload.password.as_deref())
}
