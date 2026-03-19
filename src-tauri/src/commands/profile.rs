use serde::Deserialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::connection;
use crate::profiles::store as profile_store;
use crate::profiles::types::{
    ConnectionProfile, ProfileConnectInput, ProfileConnectResult, ProfileConnectTestInput,
};
use crate::security::secrets;
use crate::state::AppState;
use crate::types::{
    ConnectionCreateInput, ConnectionInfo as AppConnectionInfo, EngineKind, MySqlConnectInput,
    PgConnectInput, RedisConnectInput, SecretRef, SecretRefKind,
};

/* ============================================================================
 * Payloads
 * ============================================================================
 */

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProfileSaveAndConnectInput {
    Create {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
    Update {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProfileSaveInput {
    Create {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
    Update {
        profile_id: Uuid,
        persist_secrets: bool,
        input: ConnectionCreateInput,
    },
}

#[derive(serde::Serialize)]
pub struct ProfileSaveAndConnectResult {
    pub profile: ConnectionProfile,
    pub connection: AppConnectionInfo,
}

/* ============================================================================
 * Validation (engine-aware, cho phép NO password)
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

    // allow no password => không check empty
    Ok(())
}

fn validate_mysql_input(my: &MySqlConnectInput) -> Result<(), String> {
    if my.host.trim().is_empty() {
        return Err("MYSQL_HOST_REQUIRED".into());
    }
    if my.database.trim().is_empty() {
        return Err("MYSQL_DATABASE_REQUIRED".into());
    }
    if my.user.trim().is_empty() {
        return Err("MYSQL_USER_REQUIRED".into());
    }
    if my.port == 0 {
        return Err("MYSQL_PORT_INVALID".into());
    }

    // allow no password
    Ok(())
}

fn validate_redis_input(r: &RedisConnectInput) -> Result<(), String> {
    if r.host.trim().is_empty() {
        return Err("REDIS_HOST_REQUIRED".into());
    }
    if r.port == 0 {
        return Err("REDIS_PORT_INVALID".into());
    }
    // allow no password
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
        EngineKind::Mysql => {
            let my = input.mysql.as_ref().ok_or("MYSQL_CONFIG_MISSING")?;
            validate_mysql_input(my)
        }
        EngineKind::Mariadb => {
            let my = input.mysql.as_ref().ok_or("MYSQL_CONFIG_MISSING")?;
            validate_mysql_input(my)
        }
        EngineKind::Redis => {
            let r = input.redis.as_ref().ok_or("REDIS_CONFIG_MISSING")?;
            validate_redis_input(r)
        }
        #[allow(unreachable_patterns)]
        _ => Err("ENGINE_NOT_SUPPORTED_YET".into()),
    }
}

/* ============================================================================
 * Secrets helpers
 * ============================================================================
 */

fn engine_key(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Postgres => "postgres",
        EngineKind::Mysql => "mysql",
        EngineKind::Mariadb => "mariadb",
        EngineKind::Redis => "redis",
        #[allow(unreachable_patterns)]
        _ => "unknown",
    }
}

fn keychain_key_for_profile(profile_id: Uuid, engine: EngineKind) -> String {
    format!("profile:{profile_id}:{}:password", engine_key(engine))
}

fn maybe_persist_secret_ref(
    app: &AppHandle,
    profile_id: Uuid,
    engine: EngineKind,
    persist_secrets: bool,
    sr: &mut SecretRef,
) -> Result<(), String> {
    if !persist_secrets {
        return Ok(());
    }

    // persist_secrets=true nhưng user để password rỗng => bỏ qua, giữ Inline "" để connect "no password"
    if sr.kind == SecretRefKind::Inline {
        let pw = sr.value.trim();
        if pw.is_empty() {
            return Ok(());
        }

        let key = keychain_key_for_profile(profile_id, engine);
        secrets::keychain_set(app, &key, pw)?;

        *sr = SecretRef {
            kind: SecretRefKind::Keychain,
            value: key,
        };
        return Ok(());
    }

    if sr.kind == SecretRefKind::Keychain && sr.value.trim().is_empty() {
        return Err("KEYCHAIN_KEY_EMPTY".into());
    }

    Ok(())
}

pub fn persist_input_with_secrets(
    app: &AppHandle,
    profile_id: Uuid,
    persist_secrets: bool,
    mut input: ConnectionCreateInput,
) -> Result<ConnectionCreateInput, String> {
    match input.engine {
        EngineKind::Postgres => {
            let pg = input.postgres.as_mut().ok_or("POSTGRES_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Postgres,
                persist_secrets,
                &mut pg.password,
            )?;
        }

        EngineKind::Mysql => {
            let my = input.mysql.as_mut().ok_or("MYSQL_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Mysql,
                persist_secrets,
                &mut my.password,
            )?;
        }

        EngineKind::Mariadb => {
            let my = input.mysql.as_mut().ok_or("MYSQL_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Mariadb,
                persist_secrets,
                &mut my.password,
            )?;
        }

        EngineKind::Redis => {
            let r = input.redis.as_mut().ok_or("REDIS_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Redis,
                persist_secrets,
                &mut r.password,
            )?;
        }
        #[allow(unreachable_patterns)]
        _ => {}
    }

    Ok(input)
}

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
    let profile = (|| -> Result<ConnectionProfile, String> {
        if is_update {
            profile_store::profile_update(&app, profile_id, input.clone())
        } else {
            profile_store::profile_create_with_id(&app, profile_id, input.clone())
        }
    })()
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
    let connection: AppConnectionInfo = connection::connection_create(app.clone(), state, input)
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
    let profile = (|| -> Result<ConnectionProfile, String> {
        if is_update {
            profile_store::profile_update(&app, profile_id, input.clone())
        } else {
            profile_store::profile_create_with_id(&app, profile_id, input.clone())
        }
    })()
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
    let connection = connection::connection_create(app.clone(), state, input)
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
    let driver = state.engines.get(base.engine.clone()).ok_or_else(|| {
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
    connection::connection_test(
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

// ============================
// Profile store commands
// ============================

#[tauri::command]
pub fn profile_list(app: AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    profile_store::profile_list(&app)
}

#[tauri::command]
pub fn profile_update(
    app: AppHandle,
    profile_id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    profile_store::profile_update(&app, profile_id, input)
}

#[tauri::command]
pub fn profile_remove(app: AppHandle, profile_id: Uuid) -> Result<(), String> {
    profile_store::profile_remove(&app, profile_id)
}
