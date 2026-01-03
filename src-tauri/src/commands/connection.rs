use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::engines::{self, EngineConnection};
use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo, EngineKind};

#[tauri::command]
pub async fn connection_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionCreateInput,
) -> Result<ConnectionInfo, String> {
    let id = Uuid::new_v4();

    match input.engine {
        EngineKind::Postgres => {
            let pg = input.postgres.ok_or("postgres config missing")?;

            // NOTE: pass AppHandle down so keychain service name is correct
            let conn = engines::postgres::driver::connect_pg(&app, id, input.label.clone(), pg)
                .await
                .map_err(|e| format!("POSTGRES_CONNECT_FAILED: {:#}", e))?;

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

#[tauri::command]
pub async fn connection_remove(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<(), String> {
    state.connections.remove(&connection_id);
    Ok(())
}

#[tauri::command]
pub async fn connection_test(
    app: tauri::AppHandle,
    input: ConnectionCreateInput,
) -> Result<(), String> {
    match input.engine {
        EngineKind::Postgres => {
            let pg = input.postgres.ok_or("postgres config missing")?;

            // chỉ test, KHÔNG insert state.connections
            engines::postgres::driver::connect_pg(&app, Uuid::new_v4(), "__test__".into(), pg)
                .await
                .map_err(|e| format!("POSTGRES_TEST_FAILED: {:#}", e))?;

            Ok(())
        }
    }
}
