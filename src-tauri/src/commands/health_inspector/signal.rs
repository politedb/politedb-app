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
    /// Why the connection itself was refused (`RUNTIME_STALE`,
    /// `RUNTIME_IDENTITY_MISSING`), so the tab can say so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn result(outcome: SignalOutcome) -> Result<SignalBackendResult, String> {
    Ok(SignalBackendResult {
        outcome,
        reason: None,
    })
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
    let pool = match crate::engines::runtime::admission::admit_runtime(&state, connection_id) {
        Ok(EngineConnection::Postgres(pg)) => pg.pool,
        Ok(_) => return result(SignalOutcome::Unavailable),
        // Not sent: the connection may take no new work (stale or unknown).
        Err(reason) if reason != "CONNECTION_NOT_FOUND" => {
            return Ok(SignalBackendResult {
                outcome: SignalOutcome::Unavailable,
                reason: Some(reason),
            })
        }
        Err(_) => return result(SignalOutcome::Unavailable),
    };
    let Ok(app_name) = postgres_app_name() else {
        return result(SignalOutcome::SetupFailed);
    };
    result(signal_backend(&pool, &target, app_name).await)
}
