use serde::Deserialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::profiles::ConnectionProfile;
use crate::commands::{connection, profiles};
use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo};

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

#[tauri::command]
pub async fn profile_save_and_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProfileSaveAndConnectInput,
) -> Result<ProfileSaveAndConnectResult, String> {
    let (profile, input) = match payload {
        ProfileSaveAndConnectInput::Create { input } => {
            let p = profiles::profile_create(app.clone(), input.clone()).await?;
            (p, input)
        }
        ProfileSaveAndConnectInput::Update { profile_id, input } => {
            let p = profiles::profile_update(app.clone(), profile_id, input.clone()).await?;
            (p, input)
        }
    };

    let conn = connection::connection_create(app.clone(), state, input).await?;

    Ok(ProfileSaveAndConnectResult {
        profile,
        connection: conn,
    })
}
