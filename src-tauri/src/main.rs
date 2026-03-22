#[cfg(target_os = "macos")]
extern crate objc2;

mod commands;
mod engines;
mod file_storage;
mod operations;
mod profiles;
mod security;
mod state;
mod types;

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

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let drivers: Vec<Arc<dyn EngineDriver>> = vec![
        Arc::new(engines::postgres::driver::PostgresDriver),
        Arc::new(engines::mysql::driver::MySqlDriver),
        Arc::new(engines::mysql::driver::MariaDbDriver),
        Arc::new(engines::mongo::driver::MongoDriver),
        Arc::new(engines::redis::driver::RedisDriver),
    ];

    let engines = EngineRegistry::new(drivers);

    tauri::Builder::default()
        .manage(state::AppState::new(engines))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            window_chrome::apply(app);
            let state: tauri::State<AppState> = app.state();
            state.sql_busy.clear();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connections
            commands::connection::connection_create,
            commands::connection::connection_list,
            commands::connection::connection_version,
            commands::connection::connection_remove,
            commands::connection::connection_test,
            // Operations
            commands::operation::operation_execute,
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
            commands::mongo::mongo_insert_documents,
            commands::mongo::mongo_update_documents,
            commands::mongo::mongo_delete_documents,
        ])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
