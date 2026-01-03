mod commands;
mod engines;
mod security;
mod state;
mod types;

use tracing_subscriber::EnvFilter;

fn main() {
    init_tracing();

    tauri::Builder::default()
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            // -------------------------------
            // Connection lifecycle
            // -------------------------------
            commands::connection::connection_create,
            commands::connection::connection_test,
            commands::connection::connection_list,
            commands::connection::connection_remove,
            // -------------------------------
            // Runtime operations
            // -------------------------------
            commands::operation::operation_execute,
            commands::operation::operation_cancel,
            // -------------------------------
            // Profiles (disk)
            // -------------------------------
            commands::profiles::profile_create,
            commands::profiles::profile_list,
            commands::profiles::profile_update,
            commands::profiles::profile_remove,
            commands::profile_save_and_connect::profile_save_and_connect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PoliteDB");
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
}
