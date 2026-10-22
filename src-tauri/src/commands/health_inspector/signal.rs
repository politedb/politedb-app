//! Thin handler: validate, find the runtime's PostgreSQL pool, delegate.

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::engines::postgres::app_name::postgres_app_name;
use crate::engines::postgres::session_signal::{signal_backend, SignalOutcome, SignalTarget};
use crate::engines::EngineConnection;
use crate::state::app_state::AppState;

#[derive(Debug, Serialize)]
pub struct SignalBackendResult {
    pub outcome: SignalOutcome,
}

fn result(outcome: SignalOutcome) -> Result<SignalBackendResult, String> {
    Ok(SignalBackendResult { outcome })
}

/// Cancel the current query of, or terminate, another client session seen in
/// the Health Inspector. Always resolves with a structured outcome so the UI
/// can tell "certainly not sent" from "may have been sent".
#[tauri::command]
pub async fn health_inspector_signal_backend(
    state: State<'_, AppState>,
    runtime_connection_id: String,
    pid: i64,
    backend_token: String,
    kind: String,
) -> Result<SignalBackendResult, String> {
    let (Ok(connection_id), Some(target)) = (
        Uuid::parse_str(&runtime_connection_id),
        SignalTarget::parse(pid, &backend_token, &kind),
    ) else {
        return result(SignalOutcome::Invalid);
    };
    // Borrow the runtime's own pool (SSH-rewritten endpoint); never open a
    // separate connection.
    let pool = match state.connections.get(&connection_id).map(|c| c.clone()) {
        Some(EngineConnection::Postgres(pg)) => pg.pool,
        _ => return result(SignalOutcome::Unavailable),
    };
    let Ok(app_name) = postgres_app_name() else {
        return result(SignalOutcome::SetupFailed);
    };
    result(signal_backend(&pool, &target, app_name).await)
}
