use tauri::AppHandle;

/// Physical service for non-macOS keyring entries (unchanged naming).
#[cfg(not(target_os = "macos"))]
fn service_name(_app: &AppHandle) -> String {
    crate::security::credential_identity::LEGACY_SERVICE.to_string()
}

/// macOS: recognized profile credentials use branded items (Name "PoliteDB",
/// Where = bundle id, Account `<UUID>_profile|_ssh`) with lazy legacy
/// migration; other keys keep the legacy service. See `credential_store`.
#[cfg(target_os = "macos")]
fn mac_store_call<T>(
    f: impl FnOnce(
        &crate::security::credential_store::CredentialStore<
            '_,
            crate::security::keychain_macos::MacKeychain,
        >,
    ) -> Result<T, String>,
) -> Result<T, String> {
    let port = crate::security::keychain_macos::MacKeychain;
    let store = crate::security::credential_store::CredentialStore::new(&port);
    f(&store)
}

/* ===============================
 * Internal helpers (backend use)
 * =============================== */

pub fn keychain_set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        mac_store_call(|store| store.set(key, value))
    }

    #[cfg(not(target_os = "macos"))]
    {
        use keyring::Entry;
        let service = service_name(app);
        let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
        entry
            .set_password(value)
            .map_err(|e| format!("KEYRING_SET_FAILED: {e}"))?;
        Ok(())
    }
}

pub fn keychain_get(app: &AppHandle, key: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        mac_store_call(|store| store.get(key))
    }

    #[cfg(not(target_os = "macos"))]
    {
        use keyring::Entry;
        let service = service_name(app);
        let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
        entry
            .get_password()
            .map_err(|e| format!("KEYRING_GET_FAILED: {e}"))
    }
}

pub fn keychain_delete(app: &AppHandle, key: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        mac_store_call(|store| store.delete(key))
    }

    #[cfg(not(target_os = "macos"))]
    {
        use keyring::Entry;
        let service = service_name(app);
        let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
        entry
            .delete_password()
            .map_err(|e| format!("KEYRING_DELETE_FAILED: {e}"))?;
        Ok(())
    }
}

pub fn keychain_list(app: &AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        mac_store_call(|store| store.list())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("KEYCHAIN_LIST_UNSUPPORTED_ON_THIS_PLATFORM".into())
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

#[tauri::command]
pub async fn secrets_list(app: AppHandle) -> Result<Vec<String>, String> {
    keychain_list(&app)
}
