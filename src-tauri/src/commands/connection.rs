// src-tauri/src/commands/connection.rs

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::engines::{self, EngineConnection};
use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo, EngineKind};

/// Create a runtime connection (in-memory) and return ConnectionInfo.
/// This DOES insert into AppState.connections after successful connect.
#[tauri::command]
pub async fn connection_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionCreateInput,
) -> Result<ConnectionInfo, String> {
    let id = Uuid::new_v4();

    match input.engine {
        EngineKind::Postgres => {
            let pg = input.postgres.ok_or("POSTGRES_CONFIG_MISSING")?;

            // Pass AppHandle down so keychain service name is correct
            let conn = engines::postgres::driver::connect_pg(&app, id, input.label.clone(), pg)
                .await
                .map_err(|e| format!("POSTGRES_CONNECT_FAILED: {:#}", e))?;

            // Insert into runtime state only after successful connect
            state
                .connections
                .insert(id, EngineConnection::Postgres(conn));

            Ok(ConnectionInfo {
                id,
                engine: EngineKind::Postgres,
                label: input.label,
            })
        }
    }
}

/// List current runtime connections (in-memory).
#[tauri::command]
pub async fn connection_list(state: State<'_, AppState>) -> Result<Vec<ConnectionInfo>, String> {
    let mut out = Vec::new();

    for c in state.connections.iter() {
        let id = *c.key();

        let (engine, label) = match c.value() {
            EngineConnection::Postgres(pg) => (EngineKind::Postgres, pg.label.clone()),
        };

        out.push(ConnectionInfo { id, engine, label });
    }

    Ok(out)
}

/// Remove a runtime connection (in-memory).
#[tauri::command]
pub async fn connection_remove(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<(), String> {
    state.connections.remove(&connection_id);
    Ok(())
}

/// Smoke test connection (no state mutation).
#[tauri::command]
pub async fn connection_test(app: AppHandle, input: ConnectionCreateInput) -> Result<(), String> {
    match input.engine {
        EngineKind::Postgres => {
            let pg = input.postgres.ok_or("POSTGRES_CONFIG_MISSING")?;

            // Test only. Do NOT insert into AppState.
            engines::postgres::driver::connect_pg(&app, Uuid::new_v4(), "__test__".into(), pg)
                .await
                .map_err(|e| format!("POSTGRES_TEST_FAILED: {:#}", e))?;

            Ok(())
        }
    }
}
