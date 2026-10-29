//! Thin commands for PostgreSQL sessions held across calls.

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::engines::postgres::sql_session::SqlSessionMode;
use crate::engines::EngineConnection;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SqlSessionBeginInput {
    pub connection_id: Uuid,
    /// "transaction" or "snapshot".
    pub mode: String,
}

#[derive(Serialize)]
pub struct SqlSessionBeginResult {
    pub session_id: Uuid,
    pub snapshot_id: Option<String>,
}

#[tauri::command]
pub async fn sql_session_begin(
    state: State<'_, AppState>,
    input: SqlSessionBeginInput,
) -> Result<SqlSessionBeginResult, String> {
    let mode = match input.mode.as_str() {
        "transaction" => SqlSessionMode::Transaction,
        "snapshot" => SqlSessionMode::Snapshot,
        _ => return Err("SQL_SESSION_MODE_INVALID".into()),
    };
    let config = match state
        .connections
        .get(&input.connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?
        .value()
    {
        EngineConnection::Postgres(pg) => pg.config.clone(),
        _ => return Err("SQL_SESSION_UNSUPPORTED".into()),
    };
    let (session_id, snapshot_id) = state
        .sql_sessions
        .begin(input.connection_id, &config, mode)
        .await?;
    // The connection may have been removed meanwhile; its cleanup then
    // missed this session.
    if !state.connections.contains_key(&input.connection_id) {
        let _ = state.sql_sessions.end(session_id, false).await;
        return Err("CONNECTION_NOT_FOUND".into());
    }
    Ok(SqlSessionBeginResult {
        session_id,
        snapshot_id,
    })
}

#[tauri::command]
pub async fn sql_session_execute(
    state: State<'_, AppState>,
    session_id: Uuid,
    sql: String,
) -> Result<(), String> {
    state.sql_sessions.execute(session_id, &sql).await
}

#[tauri::command]
pub async fn sql_session_end(
    state: State<'_, AppState>,
    session_id: Uuid,
    commit: bool,
) -> Result<(), String> {
    state.sql_sessions.end(session_id, commit).await
}
