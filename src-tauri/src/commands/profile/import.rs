use serde::Deserialize;
use tauri::AppHandle;

use crate::profiles::import_external::{self, ExternalImportResult};
use crate::profiles::store as profile_store;
use crate::profiles::types::ConnectionProfile;

use super::types::{ProfileExportFile, ProfileImportPayload, ProfileImportResult};

#[tauri::command]
pub fn profile_import(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
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

    let imported_ids: Vec<uuid::Uuid> = profiles.iter().map(|p| p.id).collect();
    // Import never carries AI data-access consent (plan ai-agent R5): a replaced
    // profile may point elsewhere. Its grants go first, in one write; if that fails,
    // nothing is imported.
    let (created, updated, profiles) = {
        let _lock = state
            .ai_consent_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::ai::agent::consent::revoke_then(
            &crate::ai::adapters::AppConsentFiles(&app),
            &imported_ids,
            || profile_store::profile_upsert_many(&app, profiles),
        )?
    };
    let total = profiles.len();

    for id in &imported_ids {
        crate::commands::ai_agent_data::cancel_profile_runs(&state, *id);
    }

    Ok(ProfileImportResult {
        created,
        updated,
        total,
        profiles,
        imported_ids,
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
