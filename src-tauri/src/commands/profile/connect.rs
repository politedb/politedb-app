use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::connection::lifecycle::{connection_test, create_runtime, error_category};
use crate::engines::driver::ConnectPolicy;
use crate::profiles::store as profile_store;
use crate::profiles::target_override::{apply_override, normalize_override, target_identity};
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

    if is_update {
        // An edited target must not be read under consent given for the old one.
        crate::commands::ai_agent_data::cancel_profile_runs(&state, profile_id);
    }

    // 4) Runtime connect (the profile's own target)
    let target = target_identity(Some(&profile), None, &input);
    let connection: AppConnectionInfo =
        create_runtime(&app, &state, input, ConnectPolicy::default(), target)
            .await
            .map_err(|e| {
                tracing::error!(
                    step = "runtime_connect",
                    mode,
                    profile_id = %profile_id,
                    error = error_category(&e),
                    "failed"
                );
                format!("RUNTIME_CONNECT_FAILED: {e}")
            })?;

    state.connection_profiles.insert(
        connection.id,
        crate::ai::agent::consent::ProfileBinding::of(&profile),
    );

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
    state: State<'_, AppState>,
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

    if is_update {
        // An edited target must not be read under consent given for the old one.
        crate::commands::ai_agent_data::cancel_profile_runs(&state, profile_id);
    }
    Ok(profile)
}

/// The agent profile binding of a connection: given for the profile's own
/// target only. A connection opened on another database (even one named
/// like the profile's own) stays unbound, so consent for one database never
/// covers another (D2).
fn binding_for(
    profile: &ConnectionProfile,
    database: &Option<String>,
) -> Option<crate::ai::agent::consent::ProfileBinding> {
    database
        .is_none()
        .then(|| crate::ai::agent::consent::ProfileBinding::of(profile))
}

/// Publishes the agent binding of a new connection, if it gets one.
fn bind_runtime(
    state: &AppState,
    connection_id: Uuid,
    profile: &ConnectionProfile,
    database: &Option<String>,
) {
    if let Some(binding) = binding_for(profile, database) {
        state.connection_profiles.insert(connection_id, binding);
    }
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

    // 2) Clone input (profile input MUST already contain SecretRef::Keychain),
    // opened on the requested database instead of its own when asked.
    let database = normalize_override(payload.database.as_deref());
    let (input, policy) = match &database {
        Some(db) => (
            apply_override(&profile.input, db)?,
            // Reopening a database a tab was opened on: a missing SQLite file
            // is an error, not a new empty database.
            ConnectPolicy {
                sqlite_create: false,
            },
        ),
        None => (profile.input.clone(), ConnectPolicy::default()),
    };
    let target = target_identity(Some(&profile), database.clone(), &input);

    // 3) Runtime connect
    let connection = create_runtime(&app, &state, input, policy, target)
        .await
        .map_err(|e| {
            tracing::error!(
                step = "runtime_connect",
                profile_id = %profile_id,
                error = error_category(&e),
                "failed"
            );
            format!("RUNTIME_CONNECT_FAILED: {e}")
        })?;

    bind_runtime(&state, connection.id, &profile, &database);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ConnectionProfile {
        let input: crate::types::ConnectionCreateInput =
            serde_json::from_value(serde_json::json!({
                "engine": "postgres", "label": "p",
                "postgres": {
                    "host": "h", "port": 5432, "database": "app", "user": "u",
                    "password": { "kind": "keychain", "value": "k" }
                }
            }))
            .unwrap();
        ConnectionProfile {
            id: Uuid::new_v4(),
            engine: input.engine,
            label: "p".into(),
            input,
            tags: vec![],
            indicator_color: None,
            created_at: 0,
            updated_at: 0,
            revision: "r".into(),
        }
    }

    /// Through the published state: a connection opened on another database
    /// has no binding, so agent data access is unavailable on it (D2).
    #[tokio::test]
    async fn an_override_connection_has_no_agent_data_access() {
        use crate::engines::registry::EngineRegistry;
        let state = AppState::new(EngineRegistry::new(vec![]));
        let p = profile();
        let path = std::env::temp_dir().join(format!("pdb-bind-{}.db", Uuid::new_v4()));
        for database in [None, Some("other".to_string()), Some("app".to_string())] {
            let id = Uuid::new_v4();
            let conn = crate::engines::sqlite::driver::connect_sqlite(
                id,
                "t".into(),
                crate::types::SqliteConnectInput {
                    path: path.to_string_lossy().into_owned(),
                    statement_timeout_ms: None,
                },
            )
            .await
            .unwrap();
            crate::commands::connection::lifecycle::publish_runtime(
                &state,
                id,
                crate::engines::EngineConnection::Sqlite(conn),
                crate::profiles::target_override::RuntimeTarget {
                    profile_id: None,
                    profile_revision: None,
                    database_override: database.clone(),
                    engine: crate::types::EngineKind::Sqlite,
                    display: "x".into(),
                },
            );
            bind_runtime(&state, id, &p, &database);
            let bound = crate::commands::ai_agent_data::data_profile(&state, &id.to_string())
                .unwrap()
                .is_some();
            assert_eq!(bound, database.is_none(), "{database:?}");
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn only_the_profiles_own_target_is_bound() {
        let p = profile();
        assert!(binding_for(&p, &None).is_some());
        assert!(binding_for(&p, &Some("other".into())).is_none());
        // Named like the profile's own database: still an override, unbound.
        assert!(binding_for(&p, &Some("app".into())).is_none());
    }
}
