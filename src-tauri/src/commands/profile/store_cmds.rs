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
    profile_id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    profile_store::profile_update(&app, profile_id, input)
}

#[tauri::command]
pub fn profile_remove(app: AppHandle, profile_id: Uuid) -> Result<(), String> {
    profile_store::profile_remove(&app, profile_id)
}
