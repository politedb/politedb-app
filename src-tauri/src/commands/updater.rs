#[cfg(target_os = "linux")]
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "linux")]
const DOWNLOAD_PAGE_URL: &str = "https://politedb.com/download?os=linux";

#[cfg(any(target_os = "linux", test))]
fn should_open_download_page(target_os: &str, appimage_is_present: bool) -> bool {
    target_os == "linux" && !appimage_is_present
}

#[cfg(target_os = "linux")]
fn open_download_page() -> Result<(), String> {
    Command::new("xdg-open")
        .arg(DOWNLOAD_PAGE_URL)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to open update download page: {error}"))
}

#[tauri::command]
pub async fn updater_install_if_allowed(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if should_open_download_page(std::env::consts::OS, std::env::var_os("APPIMAGE").is_some()) {
        return open_download_page();
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

#[cfg(test)]
mod tests {
    use super::should_open_download_page;

    #[test]
    fn linux_package_install_opens_download_page() {
        assert!(should_open_download_page("linux", false));
    }

    #[test]
    fn linux_appimage_uses_runtime_updater() {
        assert!(!should_open_download_page("linux", true));
    }

    #[test]
    fn other_platforms_use_runtime_updater() {
        assert!(!should_open_download_page("macos", false));
        assert!(!should_open_download_page("windows", false));
    }
}
