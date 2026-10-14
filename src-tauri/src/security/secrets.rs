use tauri::AppHandle;

/// Physical service for non-macOS keyring entries (unchanged naming).
#[cfg(not(target_os = "macos"))]
fn service_name(_app: &AppHandle) -> String {
    crate::security::credential_identity::LEGACY_SERVICE.to_string()
}

/// macOS: recognized profile credentials use branded items (Name and Where
/// "PoliteDB", Account `<UUID>_profile|_ssh`) with lazy migration from the
/// previous branded service and the legacy service; other keys keep the legacy
/// service. See `credential_store`.
///
/// Calls are serialized so a migrating `get` cannot interleave with a `delete`
/// of the same credential and re-create it from an old copy.
#[cfg(target_os = "macos")]
static MAC_STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "macos")]
fn mac_store_call<T>(
    f: impl FnOnce(
        &crate::security::credential_store::CredentialStore<
            '_,
            crate::security::keychain_macos::MacKeychain,
        >,
    ) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = MAC_STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

/// Like [`keychain_get`], but `Ok(None)` only when the item is absent.
/// Locked, denied or entitlement failures stay errors.
pub fn keychain_get_optional(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        match mac_store_call(|store| store.get(key)) {
            Ok(value) => Ok(Some(value)),
            Err(error) if crate::security::credential_store::is_not_found(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        use keyring::Entry;
        let service = service_name(app);
        let entry = Entry::new(&service, key).map_err(|e| format!("KEYRING_ENTRY_FAILED: {e}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("KEYRING_GET_FAILED: {e}")),
        }
    }
}

/// Like [`keychain_delete`], but an absent item is success.
pub fn keychain_delete_if_present(app: &AppHandle, key: &str) -> Result<(), String> {
    match keychain_get_optional(app, key)? {
        Some(_) => keychain_delete(app, key),
        None => Ok(()),
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
