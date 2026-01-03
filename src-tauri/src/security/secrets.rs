use keyring::Entry;
use tauri::AppHandle;

/// Build a stable service name for OS credential store.
/// - macOS: Keychain service
/// - Windows: Credential Manager target/service
/// - Linux: Secret Service collection
fn service_name(app: &AppHandle) -> String {
    // Tauri identifier is stable and unique per app bundle.
    // Example: "com.politehq.politedb"
    let identifier = app.config().identifier.clone();
    if identifier.is_empty() {
        "politedb".to_string()
    } else {
        identifier
    }
}

/// Internal: validate secret key (no empty, no crazy length).
fn validate_key(key: &str) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("SECRET_KEY_EMPTY".into());
    }
    // Keep it sane (avoid accidental huge keys stored)
    if k.len() > 200 {
        return Err("SECRET_KEY_TOO_LONG".into());
    }
    Ok(())
}

/// ===============================
/// Internal helpers (call from backend code)
/// ===============================

pub fn keychain_set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    validate_key(key)?;
    if value.is_empty() {
        // Allowing empty secrets often hides bugs; reject by default.
        return Err("SECRET_VALUE_EMPTY".into());
    }

    let service = service_name(app);
    let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("KEYRING_SET_FAILED: {e}"))?;
    Ok(())
}

pub fn keychain_get(app: &AppHandle, key: &str) -> Result<String, String> {
    validate_key(key)?;

    let service = service_name(app);
    let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("KEYRING_GET_FAILED: {e}"))
}

pub fn keychain_delete(app: &AppHandle, key: &str) -> Result<(), String> {
    validate_key(key)?;

    let service = service_name(app);
    let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
    entry
        .delete_password()
        .map_err(|e| format!("KEYRING_DELETE_FAILED: {e}"))?;
    Ok(())
}

// #[tauri::command]
pub async fn secrets_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    keychain_set(&app, &key, &value)
}

// #[tauri::command]
// pub async fn secrets_get(app: AppHandle, key: String) -> Result<String, String> {
//     keychain_get(&app, &key)
// }

// #[tauri::command]
// pub async fn secrets_delete(app: AppHandle, key: String) -> Result<(), String> {
//     keychain_delete(&app, &key)
// }
