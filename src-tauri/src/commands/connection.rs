// src-tauri/src/commands/connection.rs

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo};

#[tauri::command]
pub async fn connection_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionCreateInput,
) -> Result<ConnectionInfo, String> {
    let id = Uuid::new_v4();

    // 1) Resolve driver
    let driver = state
        .engines
        .get(input.engine.clone())
        .ok_or("ENGINE_NOT_SUPPORTED")?;

    // 2) Connect (do NOT mutate state before connect succeeds)
    let label = input.label.clone();
    let conn = driver.connect(&app, id, label.clone(), input).await?;

    // 3) Insert runtime connection
    state.connections.insert(id, conn);

    Ok(ConnectionInfo {
        id,
        engine: state
            .connections
            .get(&id)
            .map(|c| c.value().engine_kind())
            .unwrap_or_else(|| {
                // Fallback (should never happen)
                crate::types::EngineKind::Postgres
            }),
        label,
    })
}

#[tauri::command]
pub async fn connection_test(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionCreateInput,
) -> Result<(), String> {
    let driver = state
        .engines
        .get(input.engine.clone())
        .ok_or("ENGINE_NOT_SUPPORTED")?;

    driver.test(&app, input).await
}

#[tauri::command]
pub async fn connection_list(state: State<'_, AppState>) -> Result<Vec<ConnectionInfo>, String> {
    Ok(state
        .connections
        .iter()
        .map(|c| {
            let engine = c.value().engine_kind();

            ConnectionInfo {
                id: *c.key(),
                engine,
                label: c.value().label(),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn connection_remove(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<(), String> {
    // Optional: if you want to cancel/cleanup ops belonging to this connection,
    // you need op->connection mapping (not in your current state).
    // For now just remove runtime connection.
    state.connections.remove(&connection_id);
    Ok(())
}
