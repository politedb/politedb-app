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

    // ✅ safe debug context (NO password)
    let engine = input.engine.clone();
    let label = input.label.clone();

    tracing::info!(
        conn_id = %id,
        engine = ?engine,
        label = %label,
        "connection_create: start"
    );

    // 1) Resolve driver
    let driver = state
        .engines
        .get(engine.clone())
        .ok_or("ENGINE_NOT_SUPPORTED")?;

    tracing::info!(
        conn_id = %id,
        engine = ?engine,
        driver_kind = ?driver.kind(),
        "connection_create: driver resolved"
    );

    // 2) Connect (do NOT mutate state before connect succeeds)
    let conn = match driver.connect(&app, id, label.clone(), input).await {
        Ok(c) => {
            tracing::info!(conn_id = %id, engine = ?engine, "connection_create: connect ok");
            c
        }
        Err(e) => {
            // log error string (still should not include password if driver is clean)
            tracing::error!(
                conn_id = %id,
                engine = ?engine,
                error = %e,
                "connection_create: connect failed"
            );
            return Err(e);
        }
    };

    // 3) Insert runtime connection
    state.connections.insert(id, conn);

    tracing::info!(
        conn_id = %id,
        engine = ?engine,
        "connection_create: inserted into runtime state"
    );

    Ok(ConnectionInfo { id, engine, label })
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
