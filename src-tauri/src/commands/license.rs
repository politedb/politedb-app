use std::process::Command;
use tauri::AppHandle;

use crate::license::{self, LicenseDeviceInfo, LicenseState};

#[tauri::command]
pub fn license_device_info() -> Result<LicenseDeviceInfo, String> {
    Ok(license::license_device_info())
}

#[tauri::command]
pub fn license_state_load(app: AppHandle) -> Result<LicenseState, String> {
    license::license_state_load(&app)
}

#[tauri::command]
pub fn license_state_save(app: AppHandle, state: LicenseState) -> Result<LicenseState, String> {
    license::license_state_save(&app, state)
}

#[tauri::command]
pub fn license_state_clear(app: AppHandle) -> Result<LicenseState, String> {
    license::license_state_clear(&app)
}

#[tauri::command]
pub async fn license_activate(
    app: AppHandle,
    api_base: String,
    product: String,
    license_key: String,
) -> Result<LicenseState, String> {
    license::license_activate(&app, api_base, product, license_key).await
}

#[tauri::command]
pub async fn license_refresh(
    app: AppHandle,
    api_base: String,
    product: String,
) -> Result<LicenseState, String> {
    license::license_refresh(&app, api_base, product).await
}

#[tauri::command]
pub async fn license_deactivate(
    app: AppHandle,
    api_base: String,
    product: String,
) -> Result<LicenseState, String> {
    license::license_deactivate(&app, api_base, product).await
}

#[tauri::command]
pub async fn license_open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&url).status();

    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", &url]).status();

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(&url).status();

    let status = status.map_err(|e| format!("FAILED_TO_OPEN_URL: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("FAILED_TO_OPEN_URL: exited with status {status}"))
    }
}
