use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::connection::lifecycle::{connection_create, connection_test};
use crate::profiles::store as profile_store;
use crate::profiles::types::{
    ConnectionProfile, ProfileConnectInput, ProfileConnectResult, ProfileConnectTestInput,
};
use crate::state::AppState;
use crate::types::ConnectionInfo as AppConnectionInfo;

use super::secrets::persist_input_with_secrets;
use super::types::{ProfileSaveAndConnectInput, ProfileSaveAndConnectResult, ProfileSaveInput};
use crate::profiles::validate::validate_input;

#[tauri::command]
pub async fn profile_save_and_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProfileSaveAndConnectInput,
) -> Result<ProfileSaveAndConnectResult, String> {
    let (mode, profile_id, persist_secrets, mut input, is_update) = match payload {
        ProfileSaveAndConnectInput::Create {
            profile_id,
            persist_secrets,
            input,
        } => ("create", profile_id, persist_secrets, input, false),

        ProfileSaveAndConnectInput::Update {
            profile_id,
            persist_secrets,
            input,
        } => ("update", profile_id, persist_secrets, input, true),
    };

    tracing::info!(
        step = "profile_save_and_connect",
        mode,
        profile_id = %profile_id,
        persist_secrets = persist_secrets,
        engine = ?input.engine,
        label = %input.label,
        "start"
    );

    // 1) Validate
    validate_input(&input).map_err(|e| {
        tracing::error!(
            step = "validate",
            mode,
            profile_id = %profile_id,
            error = %e,
            "failed"
        );
        e
    })?;

    // 2) Persist secrets (Inline -> Keychain) if enabled
    input = persist_input_with_secrets(&app, profile_id, persist_secrets, input).map_err(|e| {
        tracing::error!(
            step = "persist_secrets",
            mode,
            profile_id = %profile_id,
            persist_secrets = persist_secrets,
            error = %e,
            "failed"
        );
        format!("PERSIST_SECRETS_FAILED: {e}")
    })?;

    // 3) Save profile (disk)
    let profile = (if is_update {
        profile_store::profile_update(&app, profile_id, input.clone())
    } else {
        profile_store::profile_create_with_id(&app, profile_id, input.clone())
    })
    .map_err(|e| {
        tracing::error!(
            step = "save_profile",
            mode,
            profile_id = %profile_id,
            is_update = is_update,
            error = %e,
            "failed"
        );
        format!("SAVE_PROFILE_FAILED: {e}")
    })?;

    // 4) Runtime connect
    let connection: AppConnectionInfo = connection_create(app.clone(), state, input)
        .await
        .map_err(|e| {
            tracing::error!(
                step = "runtime_connect",
                mode,
                profile_id = %profile_id,
                error = %e,
                "failed"
            );
            format!("RUNTIME_CONNECT_FAILED: {e}")
        })?;

    tracing::info!(
        step = "profile_save_and_connect",
        mode,
        profile_id = %profile_id,
        connection_id = %connection.id,
        "ok"
    );

    Ok(ProfileSaveAndConnectResult {
        profile,
        connection,
    })
}

#[tauri::command]
pub async fn profile_save(
    app: AppHandle,
    payload: ProfileSaveInput,
) -> Result<ConnectionProfile, String> {
    let (mode, profile_id, persist_secrets, mut input, is_update) = match payload {
        ProfileSaveInput::Create {
            profile_id,
            persist_secrets,
            input,
        } => ("create", profile_id, persist_secrets, input, false),

        ProfileSaveInput::Update {
            profile_id,
            persist_secrets,
            input,
        } => ("update", profile_id, persist_secrets, input, true),
    };

    tracing::info!(
        step = "profile_save",
        mode,
        profile_id = %profile_id,
        persist_secrets = persist_secrets,
        engine = ?input.engine,
        label = %input.label,
        "start"
    );

    // 1) Validate
    validate_input(&input).map_err(|e| {
        tracing::error!(
            step = "validate",
            mode,
            profile_id = %profile_id,
            error = %e,
            "failed"
        );
        e
    })?;

    // 2) Persist secrets (Inline -> Keychain) if enabled
    input = persist_input_with_secrets(&app, profile_id, persist_secrets, input).map_err(|e| {
        tracing::error!(
            step = "persist_secrets",
            mode,
            profile_id = %profile_id,
            persist_secrets = persist_secrets,
            error = %e,
            "failed"
        );
        format!("PERSIST_SECRETS_FAILED: {e}")
    })?;

    // 3) Save profile (disk)
    let profile = (if is_update {
        profile_store::profile_update(&app, profile_id, input.clone())
    } else {
        profile_store::profile_create_with_id(&app, profile_id, input.clone())
    })
    .map_err(|e| {
        tracing::error!(
            step = "save_profile",
            mode,
            profile_id = %profile_id,
            is_update = is_update,
            error = %e,
            "failed"
        );
        format!("SAVE_PROFILE_FAILED: {e}")
    })?;

    tracing::info!(
        step = "profile_save",
        mode,
        profile_id = %profile_id,
        "ok"
    );

    Ok(profile)
}

#[tauri::command]
pub async fn profile_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProfileConnectInput,
) -> Result<ProfileConnectResult, String> {
    let profile_id = payload.profile_id;

    tracing::info!(
        step = "profile_connect",
        profile_id = %profile_id,
        "start"
    );

    // 1) Load profile from store
    let profile = profile_store::profile_get(&app, profile_id).map_err(|e| {
        tracing::error!(
            step = "load_profile",
            profile_id = %profile_id,
            error = %e,
            "failed"
        );
        format!("PROFILE_NOT_FOUND: {e}")
    })?;

    // 2) Clone input (profile input MUST already contain SecretRef::Keychain)
    let input = profile.input.clone();

    // 3) Runtime connect
    let connection = connection_create(app.clone(), state, input)
        .await
        .map_err(|e| {
            tracing::error!(
                step = "runtime_connect",
                profile_id = %profile_id,
                error = %e,
                "failed"
            );
            format!("RUNTIME_CONNECT_FAILED: {e}")
        })?;

    tracing::info!(
        step = "profile_connect",
        profile_id = %profile_id,
        connection_id = %connection.id,
        "ok"
    );

    Ok(ProfileConnectResult {
        profile,
        connection,
    })
}

#[tauri::command]
pub async fn profile_connect_test(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProfileConnectTestInput,
) -> Result<(), String> {
    let profile_id = Uuid::parse_str(&payload.profile_id).map_err(|e| {
        tracing::error!(
            step = "parse_profile_id",
            profile_id = %payload.profile_id,
            error = %e,
            "failed"
        );
        "PROFILE_ID_INVALID".to_string()
    })?;

    tracing::info!(
        step = "profile_connect_test",
        profile_id = %profile_id,
        "start"
    );

    // 1) Load base profile from store (base should already contain SecretRef::Keychain)
    let profile: ConnectionProfile = profile_store::profile_get(&app, profile_id).map_err(|e| {
        tracing::error!(
            step = "load_profile",
            profile_id = %profile_id,
            error = %e,
            "failed"
        );
        format!("PROFILE_NOT_FOUND: {e}")
    })?;

    let base = profile.input.clone();
    let ov = payload.input;
    let secrets = payload.secrets;

    // 2) Resolve driver by base.engine (source of truth)
    let driver = state.engines.get(base.engine).ok_or_else(|| {
        tracing::error!(
            step = "resolve_driver",
            profile_id = %profile_id,
            engine = ?base.engine,
            "ENGINE_NOT_SUPPORTED"
        );
        "ENGINE_NOT_SUPPORTED".to_string()
    })?;

    // 3) Merge for test (engine-specific logic lives in driver)
    let merged = driver
        .merge_for_test(base, ov, secrets.clone())
        .map_err(|e| {
            tracing::error!(
                step = "merge_for_test",
                profile_id = %profile_id,
                error = %e,
                "failed"
            );
            format!("PROFILE_TEST_MERGE_FAILED: {e}")
        })?;

    // 4) Reuse connection_test pipeline (SSH tunnel + rewrite + driver.test + close tunnel)
    connection_test(
        app.clone(),
        state,
        crate::types::ConnectionTestInput {
            input: merged,
            secrets,
        },
    )
    .await
    .map_err(|e| {
        tracing::error!(
            step = "test_profile_connection",
            profile_id = %profile_id,
            error = %e,
            "failed"
        );
        format!("PROFILE_TEST_FAILED: {e}")
    })?;

    tracing::info!(
        step = "profile_connect_test",
        profile_id = %profile_id,
        "ok"
    );

    Ok(())
}
