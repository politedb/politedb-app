mod commands;
mod engines;
mod security;
mod state;
mod types;

use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::connection::connection_create,
            commands::connection::connection_list,
            commands::connection::connection_remove,
            commands::operation::operation_execute,
            commands::operation::operation_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PoliteDB");
}
