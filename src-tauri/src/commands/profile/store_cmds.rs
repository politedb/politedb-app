use tauri::AppHandle;
use uuid::Uuid;

use crate::profiles::store as profile_store;
use crate::profiles::types::ConnectionProfile;
use crate::types::ConnectionCreateInput;

#[tauri::command]
pub fn profile_list(app: AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    profile_store::profile_list(&app)
}

#[tauri::command]
pub fn profile_update(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    let profile = profile_store::profile_update(&app, profile_id, input)?;
    // An edited target must not be read under consent given for the old one.
    crate::commands::ai_agent_data::cancel_profile_runs(&state, profile_id);
    Ok(profile)
}

#[tauri::command]
pub fn profile_remove(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: Uuid,
) -> Result<(), String> {
    profile_store::profile_remove(&app, profile_id)?;
    crate::commands::ai_agent_data::cancel_profile_runs(&state, profile_id);
    // A deleted profile keeps no AI data-access consent (plan ai-agent R5).
    let _lock = state
        .ai_consent_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::ai::agent::consent::revoke_profile(
        &crate::ai::adapters::AppConsentFiles(&app),
        profile_id,
    )
}
