use serde::Deserialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::connection;
use crate::profiles::store as profile_store;
use crate::profiles::types::ConnectionProfile;
use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo, EngineKind, PgConnectInput};

/* ============================================================================
 * Payloads
 * ============================================================================
 */

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProfileSaveAndConnectInput {
    Create {
        input: ConnectionCreateInput,
    },
    Update {
        profile_id: Uuid,
        input: ConnectionCreateInput,
    },
}

#[derive(serde::Serialize)]
pub struct ProfileSaveAndConnectResult {
    pub profile: ConnectionProfile,
    pub connection: ConnectionInfo,
}

/* ============================================================================
 * Validation (engine-aware, extendable)
 * ============================================================================
 */

fn validate_pg_input(pg: &PgConnectInput) -> Result<(), String> {
    if pg.host.trim().is_empty() {
        return Err("PG_HOST_REQUIRED".into());
    }
    if pg.database.trim().is_empty() {
        return Err("PG_DATABASE_REQUIRED".into());
    }
    if pg.user.trim().is_empty() {
        return Err("PG_USER_REQUIRED".into());
    }
    if pg.port == 0 {
        return Err("PG_PORT_INVALID".into());
    }
    if pg.password.value.trim().is_empty() {
        return Err("PG_PASSWORD_REQUIRED".into());
    }
    Ok(())
}

fn validate_input(input: &ConnectionCreateInput) -> Result<(), String> {
    if input.label.trim().is_empty() {
        return Err("LABEL_REQUIRED".into());
    }

    match input.engine {
        EngineKind::Postgres => {
            let pg = input.postgres.as_ref().ok_or("POSTGRES_CONFIG_MISSING")?;
            validate_pg_input(pg)
        }

        // EngineKind::Mysql => {
        //     let my = input.mysql.as_ref().ok_or("MYSQL_CONFIG_MISSING")?;
        //     validate_mysql_input(my)
        // }
        _ => Err("ENGINE_NOT_SUPPORTED_YET".into()),
    }
}

/* ============================================================================
 * Command
 * ============================================================================
 */

#[tauri::command]
pub async fn profile_save_and_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProfileSaveAndConnectInput,
) -> Result<ProfileSaveAndConnectResult, String> {
    let (profile, input) = match payload {
        ProfileSaveAndConnectInput::Create { input } => {
            validate_input(&input)?;
            let profile = profile_store::profile_create(&app, input.clone())?;
            (profile, input)
        }
        ProfileSaveAndConnectInput::Update { profile_id, input } => {
            validate_input(&input)?;
            let profile = profile_store::profile_update(&app, profile_id, input.clone())?;
            (profile, input)
        }
    };

    // Connect runtime (creates a NEW runtime connection id each time)
    // If later you want "one runtime conn per profile", you can add a mapping layer.
    let connection: ConnectionInfo =
        connection::connection_create(app.clone(), state, input).await?;

    Ok(ProfileSaveAndConnectResult {
        profile,
        connection,
    })
}
