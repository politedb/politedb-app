#[cfg(target_os = "macos")]
extern crate objc2;

mod ai_runtime;
mod commands;
mod engines;
mod file_storage;
mod license;
mod operations;
mod profiles;
mod security;
mod state;
mod types;

use crate::security::secrets;
use crate::state::AppState;

mod ssh_tunnel;

mod window_chrome;
#[cfg(target_os = "macos")]
use std::process::Command as StdCommand;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

use engines::driver::EngineDriver;
use engines::registry::EngineRegistry;

// Needed for `app.state()` and other app/window extension methods.
use tauri::Manager;

#[cfg(target_os = "macos")]
const MIN_SUPPORTED_MACOS_MAJOR: u32 = 13;
#[cfg(target_os = "macos")]
const MIN_SUPPORTED_MACOS_MINOR: u32 = 3;

#[cfg(target_os = "macos")]
fn parse_macos_version(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

#[cfg(target_os = "macos")]
fn is_supported_macos_version(version: (u32, u32, u32)) -> bool {
    let (major, minor, _) = version;
    major > MIN_SUPPORTED_MACOS_MAJOR
        || (major == MIN_SUPPORTED_MACOS_MAJOR && minor >= MIN_SUPPORTED_MACOS_MINOR)
}

#[cfg(target_os = "macos")]
fn show_unsupported_macos_alert(current_version: &str) {
    let message = format!(
        "PoliteDB requires macOS {}.{} or later.\\nCurrent macOS version: {}",
        MIN_SUPPORTED_MACOS_MAJOR, MIN_SUPPORTED_MACOS_MINOR, current_version
    );

    let _ = StdCommand::new("osascript")
        .args([
            "-e",
            &format!(
                "display alert \"Unsupported macOS Version\" message \"{}\" as critical buttons {{\"OK\"}} default button \"OK\"",
                message.replace('\\', "\\\\").replace('"', "\\\"")
            ),
        ])
        .status();
}

#[cfg(target_os = "macos")]
fn enforce_minimum_macos_version() -> Result<(), String> {
    let output = StdCommand::new("sw_vers")
        .arg("-productVersion")
        .output()
        .map_err(|e| format!("Failed to read macOS version: {e}"))?;

    let version = String::from_utf8(output.stdout)
        .map_err(|e| format!("Failed to decode macOS version: {e}"))?;
    let parsed = parse_macos_version(&version)
        .ok_or_else(|| format!("Failed to parse macOS version: {}", version.trim()))?;

    if is_supported_macos_version(parsed) {
        Ok(())
    } else {
        show_unsupported_macos_alert(version.trim());
        Err(format!(
            "PoliteDB requires macOS {}.{} or later. Current version: {}",
            MIN_SUPPORTED_MACOS_MAJOR,
            MIN_SUPPORTED_MACOS_MINOR,
            version.trim()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn enforce_minimum_macos_version() -> Result<(), String> {
    Ok(())
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let drivers: Vec<Arc<dyn EngineDriver>> = vec![
        Arc::new(engines::postgres::driver::PostgresDriver),
        Arc::new(engines::mysql::driver::MySqlDriver),
        Arc::new(engines::mysql::driver::MariaDbDriver),
        Arc::new(engines::sqlserver::driver::SqlServerDriver),
        Arc::new(engines::sqlite::driver::SqliteDriver),
        Arc::new(engines::oracle::driver::OracleDriver),
        Arc::new(engines::mongo::driver::MongoDriver),
        Arc::new(engines::redis::driver::RedisDriver),
    ];

    let engines = EngineRegistry::new(drivers);

    let app = tauri::Builder::default()
        .manage(state::AppState::new(engines))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            enforce_minimum_macos_version()?;
            window_chrome::apply(app);
            let state: tauri::State<AppState> = app.state();
            state.sql_busy.clear();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state: tauri::State<'_, AppState> = app_handle.state();
                let _ = ai_runtime::ai_runtime_autostart_if_available(&app_handle, &state).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_quit,
            commands::ai::ai_runtime_status,
            commands::ai::ai_runtime_start,
            commands::ai::ai_runtime_stop,
            commands::ai::ai_runtime_download_default_model,
            commands::ai::ai_runtime_cancel_model_download,
            commands::license::license_device_info,
            commands::license::license_state_load,
            commands::license::license_state_save,
            commands::license::license_state_clear,
            commands::license::license_activate,
            commands::license::license_refresh,
            commands::license::license_deactivate,
            commands::license::license_open_external_url,
            commands::security::security_touch_id_authenticate,
            // Connections
            commands::connection::connection_create,
            commands::connection::connection_list,
            commands::connection::connection_version,
            commands::connection::connection_remove,
            commands::connection::connection_test,
            // Operations
            commands::operation::operation_execute,
            commands::operation::operation_execute_transaction,
            commands::operation::operation_cancel,
            commands::operation::operation_chunk_ack,
            // Profiles
            commands::profile::profile_list,
            commands::profile::profile_update,
            commands::profile::profile_save,
            commands::profile::profile_remove,
            // Profiles + connect
            commands::profile::profile_save,
            commands::profile::profile_save_and_connect,
            commands::profile::profile_connect,
            commands::profile::profile_connect_test,
            commands::profile::profile_export,
            commands::profile::profile_export_one,
            commands::profile::profile_export_one_encrypted,
            commands::profile::profile_decrypt_export,
            commands::profile::profile_is_encrypted_export,
            commands::profile::profile_import,
            commands::profile::profile_import_external,
            // secrets
            secrets::secrets_set,
            secrets::secrets_get,
            secrets::secrets_delete,
            secrets::secrets_list,
            // sql draft
            commands::sql_draft::sql_draft_save,
            commands::sql_draft::sql_draft_load,
            commands::sql_draft::sql_draft_clear,
            commands::sql_draft::sql_draft_gc,
            // persistent
            commands::persistent::persistent_load,
            commands::persistent::persistent_save,
            commands::persistent::persistent_clear,
            // export (streaming append for large table export)
            commands::export::export_append_to_file,
            // mongo
            commands::mongo::mongo_list_databases,
            commands::mongo::mongo_list_collections,
            commands::mongo::mongo_collection_overview,
            commands::mongo::mongo_find_documents,
            commands::mongo::mongo_list_indexes,
            commands::mongo::mongo_collection_size_info,
            commands::mongo::mongo_insert_documents,
            commands::mongo::mongo_update_documents,
            commands::mongo::mongo_delete_documents,
            commands::updater::updater_install_if_allowed,
        ])
        .build(tauri::generate_context!())
        .expect("error while building app");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            let state: tauri::State<'_, AppState> = app_handle.state();
            ai_runtime::ai_runtime_force_shutdown_blocking(&state);
        }
    });
}
