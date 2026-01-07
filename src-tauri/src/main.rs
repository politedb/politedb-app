#[cfg(target_os = "macos")]
extern crate objc2;

mod commands;
mod engines;
mod operations;
mod profiles;
mod security;
mod state;
mod types;

use crate::security::secrets;

mod ssh_tunnel;

mod window_chrome;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

use engines::driver::EngineDriver;
use engines::registry::EngineRegistry;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let drivers: Vec<Arc<dyn EngineDriver>> = vec![
        Arc::new(engines::postgres::driver::PostgresDriver),
        Arc::new(engines::mysql::driver::MySqlDriver),
        Arc::new(engines::redis::driver::RedisDriver),
    ];

    let engines = EngineRegistry::new(drivers);

    tauri::Builder::default()
        .manage(state::AppState::new(engines))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            window_chrome::apply(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connections
            commands::connection::connection_list,
            commands::connection::connection_remove,
            commands::connection::connection_test,
            // Operations
            commands::operation::operation_execute,
            commands::operation::operation_cancel,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
