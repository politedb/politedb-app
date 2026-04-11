use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::license;

#[tauri::command]
pub async fn updater_install_if_allowed(app: AppHandle) -> Result<(), String> {
    let license_state = license::license_state_load(&app)?;
    if license::blocks_app_update(&license_state) {
        return Err(
            "App updates are disabled because the free trial or license has expired."
                .to_string(),
        );
    }

    let updater = app
        .updater()
        .map_err(|e| format!("Failed to initialize updater: {e}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {e}"))?
    else {
        return Ok(());
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Failed to download and install update: {e}"))?;

    app.restart();
}
