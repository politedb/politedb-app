use tauri::AppHandle;
use uuid::Uuid;

use crate::profiles::export_crypto;
use crate::profiles::sharing;
use crate::profiles::store as profile_store;
use crate::profiles::types::ConnectionProfile;

use super::types::ProfileExportFile;

fn build_sharing_export_file(
    app: &AppHandle,
    mut profiles: Vec<ConnectionProfile>,
    options: sharing::SharingExportOptions,
) -> Result<ProfileExportFile, String> {
    for profile in &mut profiles {
        sharing::prepare_profile_for_sharing_export(app, profile, &options)?;
    }

    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let secrets_redacted = !options.include_db_password && !options.include_ssh_password;

    Ok(ProfileExportFile {
        version: profile_store::profile_file_version(),
        exported_at,
        profiles,
        export_mode: Some("sharing".into()),
        secrets_redacted,
        sharing_checklist: sharing::sharing_checklist(&options),
        included_db_password: options.include_db_password,
        included_ssh_password: options.include_ssh_password,
    })
}

fn serialize_export_file(file: &ProfileExportFile) -> Result<String, String> {
    serde_json::to_string_pretty(file).map_err(|e| format!("PROFILE_EXPORT_SERIALIZE_FAILED: {e}"))
}

#[tauri::command]
pub fn profile_export(
    app: AppHandle,
    include_db_password: Option<bool>,
    include_ssh_password: Option<bool>,
) -> Result<String, String> {
    let profiles = profile_store::profile_list(&app)?;
    let options = sharing::SharingExportOptions {
        include_db_password: include_db_password.unwrap_or(false),
        include_ssh_password: include_ssh_password.unwrap_or(false),
    };
    let file = build_sharing_export_file(&app, profiles, options)?;
    serialize_export_file(&file)
}

#[tauri::command]
pub fn profile_export_one(
    app: AppHandle,
    profile_id: Uuid,
    include_db_password: Option<bool>,
    include_ssh_password: Option<bool>,
) -> Result<String, String> {
    let profile = profile_store::profile_get(&app, profile_id)?;
    let options = sharing::SharingExportOptions {
        include_db_password: include_db_password.unwrap_or(false),
        include_ssh_password: include_ssh_password.unwrap_or(false),
    };
    let file = build_sharing_export_file(&app, vec![profile], options)?;
    serialize_export_file(&file)
}

#[tauri::command]
pub fn profile_export_one_encrypted(
    app: AppHandle,
    profile_id: Uuid,
    password: String,
    include_db_password: Option<bool>,
    include_ssh_password: Option<bool>,
) -> Result<String, String> {
    let profile = profile_store::profile_get(&app, profile_id)?;
    let options = sharing::SharingExportOptions {
        include_db_password: include_db_password.unwrap_or(false),
        include_ssh_password: include_ssh_password.unwrap_or(false),
    };
    let file = build_sharing_export_file(&app, vec![profile], options)?;
    let plaintext = serialize_export_file(&file)?;
    export_crypto::encrypt_export_payload(&plaintext, &password)
}

#[tauri::command]
pub fn profile_decrypt_export(encrypted_json: String, password: String) -> Result<String, String> {
    export_crypto::decrypt_export_payload(&encrypted_json, &password)
}

#[tauri::command]
pub fn profile_is_encrypted_export(json: String) -> bool {
    export_crypto::is_encrypted_export(&json)
}
