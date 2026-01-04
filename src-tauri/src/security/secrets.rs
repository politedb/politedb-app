use tauri::AppHandle;

fn service_name(app: &AppHandle) -> String {
    let identifier = app.config().identifier.clone();
    if identifier.is_empty() {
        "politedb".to_string()
    } else {
        identifier
    }
}

/* ===============================
 * Internal helpers (backend use)
 * =============================== */

pub fn keychain_set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let service = service_name(app);

    #[cfg(target_os = "macos")]
    {
        return crate::security::keychain_macos::set_password(&service, key, value);
    }

    #[cfg(not(target_os = "macos"))]
    {
        use keyring::Entry;
        let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
        entry
            .set_password(value)
            .map_err(|e| format!("KEYRING_SET_FAILED: {e}"))?;
        Ok(())
    }
}

pub fn keychain_get(app: &AppHandle, key: &str) -> Result<String, String> {
    let service = service_name(app);

    #[cfg(target_os = "macos")]
    {
        return crate::security::keychain_macos::get_password(&service, key);
    }

    #[cfg(not(target_os = "macos"))]
    {
        use keyring::Entry;
        let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
        entry
            .get_password()
            .map_err(|e| format!("KEYRING_GET_FAILED: {e}"))
    }
}

pub fn keychain_delete(app: &AppHandle, key: &str) -> Result<(), String> {
    let service = service_name(app);

    #[cfg(target_os = "macos")]
    {
        return crate::security::keychain_macos::delete_password(&service, key);
    }

    #[cfg(not(target_os = "macos"))]
    {
        use keyring::Entry;
        let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
        entry
            .delete_password()
            .map_err(|e| format!("KEYRING_DELETE_FAILED: {e}"))?;
        Ok(())
    }
}

/* ===============================
 * Tauri commands (FE invoke)
 * =============================== */

#[tauri::command]
pub async fn secrets_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    keychain_set(&app, &key, &value)
}

#[tauri::command]
pub async fn secrets_get(app: AppHandle, key: String) -> Result<String, String> {
    keychain_get(&app, &key)
}

#[tauri::command]
pub async fn secrets_delete(app: AppHandle, key: String) -> Result<(), String> {
    keychain_delete(&app, &key)
}
