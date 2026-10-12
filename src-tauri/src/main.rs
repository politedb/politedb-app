#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
extern crate objc2;

mod ai;
mod commands;
mod data_migration;
mod distribution;
mod engines;
mod file_storage;
mod license;
mod operations;
mod platform;
mod profiles;
mod security;
mod state;
mod types;

use crate::distribution::Distribution;
use crate::security::secrets;
use crate::state::AppState;

mod ssh_tunnel;

mod window_chrome;
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
fn is_supported_macos_version(version: (u32, u32, u32)) -> bool {
    let (major, minor, _) = version;
    major > MIN_SUPPORTED_MACOS_MAJOR
        || (major == MIN_SUPPORTED_MACOS_MAJOR && minor >= MIN_SUPPORTED_MACOS_MINOR)
}

/// `13.3` / `13.3.1`, matching how `sw_vers -productVersion` prints versions.
#[cfg(target_os = "macos")]
fn format_macos_version((major, minor, patch): (u32, u32, u32)) -> String {
    if patch == 0 {
        format!("{major}.{minor}")
    } else {
        format!("{major}.{minor}.{patch}")
    }
}

#[cfg(target_os = "macos")]
fn enforce_minimum_macos_version() -> Result<(), String> {
    let version = platform::macos::os_version();
    if is_supported_macos_version(version) {
        return Ok(());
    }
    let current = format_macos_version(version);
    platform::macos::show_critical_alert(
        "Unsupported macOS Version",
        &format!(
            "PoliteDB requires macOS {MIN_SUPPORTED_MACOS_MAJOR}.{MIN_SUPPORTED_MACOS_MINOR} or later.\nCurrent macOS version: {current}"
        ),
    );
    Err(format!(
        "PoliteDB requires macOS {MIN_SUPPORTED_MACOS_MAJOR}.{MIN_SUPPORTED_MACOS_MINOR} or later. Current version: {current}"
    ))
}

#[cfg(not(target_os = "macos"))]
fn enforce_minimum_macos_version() -> Result<(), String> {
    Ok(())
}

fn main() {
    // Ensure rustls has a process-level crypto provider before any TLS usage.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let drivers: Vec<Arc<dyn EngineDriver>> = vec![
        Arc::new(engines::postgres::driver::PostgresDriver),
        Arc::new(engines::mysql::driver::MySqlDriver),
        Arc::new(engines::mysql::driver::MariaDbDriver),
        Arc::new(engines::sqlserver::driver::SqlServerDriver),
        Arc::new(engines::sqlite::driver::SqliteDriver),
        Arc::new(engines::duckdb::driver::DuckdbDriver),
        Arc::new(engines::d1::driver::D1Driver),
        Arc::new(engines::turso::driver::TursoDriver),
        Arc::new(engines::oracle::driver::OracleDriver),
        Arc::new(engines::mongo::driver::MongoDriver),
        Arc::new(engines::cassandra::driver::CassandraDriver),
        Arc::new(engines::redis::driver::RedisDriver),
        Arc::new(engines::snowflake::driver::SnowflakeDriver),
        Arc::new(engines::clickhouse::driver::ClickhouseDriver),
        Arc::new(engines::google_sheets::driver::GoogleSheetsDriver),
    ];

    let distribution = Distribution::current();
    let drivers = drivers
        .into_iter()
        .filter(|driver| distribution.supports_engine(driver.kind()))
        .collect();

    let engines = EngineRegistry::new(drivers);

    let mut builder = tauri::Builder::default().manage(state::AppState::new(engines));
    if distribution.supports_self_update() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            enforce_minimum_macos_version()?;
            data_migration::migrate_legacy_app_data(app.handle());
            window_chrome::apply(app);
            let state: tauri::State<AppState> = app.state();
            state.sql_busy.clear();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_quit,
            commands::ai::ai_provider_list,
            commands::ai::ai_provider_save,
            commands::ai::ai_provider_delete,
            commands::ai::ai_provider_list_models,
            commands::ai::ai_provider_cancel_list_models,
            commands::ai::ai_provider_test_draft,
            commands::ai::ai_legacy_model_info,
            commands::ai::ai_legacy_model_delete,
            commands::ai::ai_chat_complete,
            commands::ai::ai_chat_cancel,
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
            commands::connection::lifecycle::connection_create,
            commands::connection::lifecycle::connection_list,
            commands::connection::version::connection_version,
            commands::connection::lifecycle::connection_remove,
            commands::connection::lifecycle::connection_test,
            // Operations
            commands::operation::operation_execute,
            commands::operation::operation_execute_transaction,
            commands::operation::operation_import_csv_transaction,
            commands::operation::operation_cancel,
            commands::operation::operation_chunk_ack,
            // Profiles
            commands::profile::store_cmds::profile_list,
            commands::profile::store_cmds::profile_update,
            commands::profile::store_cmds::profile_remove,
            commands::profile::connect::profile_save,
            commands::profile::connect::profile_save_and_connect,
            commands::profile::connect::profile_connect,
            commands::profile::connect::profile_connect_test,
            commands::profile::export::profile_export,
            commands::profile::export::profile_export_one,
            commands::profile::export::profile_export_one_encrypted,
            commands::profile::export::profile_decrypt_export,
            commands::profile::export::profile_is_encrypted_export,
            commands::profile::import::profile_import,
            commands::profile::import::profile_import_external,
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
            // snippets library
            commands::snippets::snippets_load,
            commands::snippets::snippets_save,
            // persistent
            commands::persistent::persistent_load,
            commands::persistent::persistent_save,
            commands::persistent::persistent_clear,
            // export (streaming append + scoped temp session)
            commands::export::export_append_to_file,
            commands::export::export_session_begin,
            commands::export::export_session_append,
            commands::export::export_session_publish,
            commands::export::export_session_abort,
            // cassandra
            commands::cassandra::cassandra_list_keyspaces,
            commands::cassandra::cassandra_list_tables,
            commands::cassandra::cassandra_table_overview,
            commands::cassandra::cassandra_fetch_rows,
            commands::cassandra::cassandra_primary_key_columns,
            commands::cassandra::cassandra_update_rows,
            // Google Sheets
            commands::google_sheets::google_sheets_list_sheets,
            commands::google_sheets::google_sheets_sheet_overview,
            commands::google_sheets::google_sheets_fetch_rows,
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

    app.run(|_app_handle, _event| {});
}

#[cfg(all(test, target_os = "macos"))]
mod macos_version_tests {
    use super::*;

    #[test]
    fn enforces_the_minimum_version() {
        assert!(is_supported_macos_version((13, 3, 0)));
        assert!(is_supported_macos_version((14, 0, 0)));
        assert!(!is_supported_macos_version((13, 2, 1)));
        assert!(!is_supported_macos_version((12, 7, 6)));
    }

    #[test]
    fn formats_versions_like_sw_vers() {
        assert_eq!(format_macos_version((13, 3, 0)), "13.3");
        assert_eq!(format_macos_version((14, 6, 1)), "14.6.1");
    }

    #[test]
    fn current_mac_is_supported() {
        assert!(enforce_minimum_macos_version().is_ok());
    }
}
