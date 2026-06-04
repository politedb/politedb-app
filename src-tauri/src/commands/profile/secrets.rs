use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::types::ConnectionCreateInput;

/// Persist inline secrets to the keychain via the engine driver.
pub fn persist_input_with_secrets(
    app: &AppHandle,
    profile_id: uuid::Uuid,
    persist_secrets: bool,
    input: ConnectionCreateInput,
) -> Result<ConnectionCreateInput, String> {
    let state = app.state::<AppState>();
    let engine = input.engine.clone();
    let driver = state.engines.get(engine).ok_or("ENGINE_NOT_SUPPORTED")?;
    driver.persist_profile_secrets(app, profile_id, persist_secrets, input)
}
