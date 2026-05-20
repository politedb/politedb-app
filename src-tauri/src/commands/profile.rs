use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::connection;
use crate::profiles::export_crypto;
use crate::profiles::import_external::{self, ExternalImportResult};
use crate::profiles::sharing;
use crate::profiles::store as profile_store;
use crate::profiles::types::{
    ConnectionProfile, ProfileConnectInput, ProfileConnectResult, ProfileConnectTestInput,
};
use crate::security::secrets;
use crate::state::AppState;
use crate::types::{
    ConnectionCreateInput, ConnectionInfo as AppConnectionInfo, D1ConnectInput, DuckdbConnectInput,
    EngineKind, MongoConnectInput, MySqlConnectInput, OracleConnectInput, PgConnectInput,
    RedisConnectInput, SecretRef, SecretRefKind, SnowflakeConnectInput, SqlServerConnectInput,
    SqliteConnectInput,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileExportFile {
    pub version: u32,
    pub exported_at: i64,
    pub profiles: Vec<ConnectionProfile>,

    /// `sharing` when secrets were redacted for cross-device handoff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_mode: Option<String>,

    #[serde(default)]
    pub secrets_redacted: bool,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sharing_checklist: Vec<String>,

    #[serde(default)]
    pub included_db_password: bool,

    #[serde(default)]
    pub included_ssh_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileImportPayload {
    pub json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileImportResult {
    pub created: usize,
    pub updated: usize,
    pub total: usize,
    pub profiles: Vec<ConnectionProfile>,
}

/* ============================================================================
 * Validation (engine-aware, allows NO password)
 * ============================================================================
 */

fn validate_pg_input(pg: &PgConnectInput) -> Result<(), String> {
    if pg.host.trim().is_empty() {
        return Err("PG_HOST_REQUIRED".into());
    }
    if pg.user.trim().is_empty() {
        return Err("PG_USER_REQUIRED".into());
    }
    if pg.port == 0 {
        return Err("PG_PORT_INVALID".into());
    }

    // allow no password => do not require a non-empty password
    Ok(())
}

fn validate_mysql_input(my: &MySqlConnectInput) -> Result<(), String> {
    if my.host.trim().is_empty() {
        return Err("MYSQL_HOST_REQUIRED".into());
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

fn validate_mongo_input(m: &MongoConnectInput) -> Result<(), String> {
    if m.host.trim().is_empty() {
        return Err("MONGO_HOST_REQUIRED".into());
    }
    if m.port == 0 {
        return Err("MONGO_PORT_INVALID".into());
    }
    Ok(())
}

fn validate_duckdb_input(s: &DuckdbConnectInput) -> Result<(), String> {
    if s.path.trim().is_empty() {
        return Err("DUCKDB_PATH_REQUIRED".into());
    }
    Ok(())
}

fn validate_sqlite_input(s: &SqliteConnectInput) -> Result<(), String> {
    if s.path.trim().is_empty() {
        return Err("SQLITE_PATH_REQUIRED".into());
    }
    Ok(())
}

fn validate_d1_input(d1: &D1ConnectInput) -> Result<(), String> {
    if d1.account_id.trim().is_empty() {
        return Err("D1_ACCOUNT_ID_REQUIRED".into());
    }
    if d1.database_id.trim().is_empty() {
        return Err("D1_DATABASE_ID_REQUIRED".into());
    }
    Ok(())
}

fn validate_snowflake_input(sf: &SnowflakeConnectInput) -> Result<(), String> {
    if sf.account.trim().is_empty() {
        return Err("SNOWFLAKE_ACCOUNT_REQUIRED".into());
    }
    if sf.warehouse.trim().is_empty() {
        return Err("SNOWFLAKE_WAREHOUSE_REQUIRED".into());
    }
    if sf.database.trim().is_empty() {
        return Err("SNOWFLAKE_DATABASE_REQUIRED".into());
    }
    if sf.user.trim().is_empty() {
        return Err("SNOWFLAKE_USER_REQUIRED".into());
    }
    Ok(())
}

fn validate_sqlserver_input(ss: &SqlServerConnectInput) -> Result<(), String> {
    if ss.host.trim().is_empty() {
        return Err("SQLSERVER_HOST_REQUIRED".into());
    }
    if ss.user.trim().is_empty() {
        return Err("SQLSERVER_USER_REQUIRED".into());
    }
    if ss.port == 0 {
        return Err("SQLSERVER_PORT_INVALID".into());
    }
    Ok(())
}

fn validate_oracle_input(oc: &OracleConnectInput) -> Result<(), String> {
    if oc.host.trim().is_empty() {
        return Err("ORACLE_HOST_REQUIRED".into());
    }
    if oc.user.trim().is_empty() {
        return Err("ORACLE_USER_REQUIRED".into());
    }
    if oc.port == 0 {
        return Err("ORACLE_PORT_INVALID".into());
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
        EngineKind::Mysql => {
            let my = input.mysql.as_ref().ok_or("MYSQL_CONFIG_MISSING")?;
            validate_mysql_input(my)
        }
        EngineKind::Mariadb => {
            let my = input.mysql.as_ref().ok_or("MYSQL_CONFIG_MISSING")?;
            validate_mysql_input(my)
        }
        EngineKind::Sqlserver => {
            let ss = input.sqlserver.as_ref().ok_or("SQLSERVER_CONFIG_MISSING")?;
            validate_sqlserver_input(ss)
        }
        EngineKind::Sqlite => {
            let s = input.sqlite.as_ref().ok_or("SQLITE_CONFIG_MISSING")?;
            validate_sqlite_input(s)
        }
        EngineKind::Duckdb => {
            let d = input.duckdb.as_ref().ok_or("DUCKDB_CONFIG_MISSING")?;
            validate_duckdb_input(d)
        }
        EngineKind::D1 => {
            let d1 = input.d1.as_ref().ok_or("D1_CONFIG_MISSING")?;
            validate_d1_input(d1)
        }
        EngineKind::Oracle => {
            let oc = input.oracle.as_ref().ok_or("ORACLE_CONFIG_MISSING")?;
            validate_oracle_input(oc)
        }
        EngineKind::Mongo => {
            let mongo = input.mongo.as_ref().ok_or("MONGO_CONFIG_MISSING")?;
            validate_mongo_input(mongo)
        }
        EngineKind::Redis => {
            let r = input.redis.as_ref().ok_or("REDIS_CONFIG_MISSING")?;
            validate_redis_input(r)
        }
        EngineKind::Snowflake => {
            let sf = input.snowflake.as_ref().ok_or("SNOWFLAKE_CONFIG_MISSING")?;
            validate_snowflake_input(sf)
        }
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
        EngineKind::Sqlserver => "sqlserver",
        EngineKind::Sqlite => "sqlite",
        EngineKind::Duckdb => "duckdb",
        EngineKind::D1 => "d1",
        EngineKind::Oracle => "oracle",
        EngineKind::Mongo => "mongo",
        EngineKind::Redis => "redis",
        EngineKind::Snowflake => "snowflake",
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

    // persist_secrets=true but empty password => skip; keep Inline "" for no-password connect
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
        EngineKind::Sqlserver => {
            let ss = input.sqlserver.as_mut().ok_or("SQLSERVER_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Sqlserver,
                persist_secrets,
                &mut ss.password,
            )?;
        }
        EngineKind::Oracle => {
            let oc = input.oracle.as_mut().ok_or("ORACLE_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Oracle,
                persist_secrets,
                &mut oc.password,
            )?;
        }
        EngineKind::Snowflake => {
            let sf = input.snowflake.as_mut().ok_or("SNOWFLAKE_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Snowflake,
                persist_secrets,
                &mut sf.password,
            )?;
        }
        EngineKind::Sqlite => {}
        EngineKind::Duckdb => {}
        EngineKind::D1 => {
            let d1 = input.d1.as_mut().ok_or("D1_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::D1,
                persist_secrets,
                &mut d1.api_token,
            )?;
        }

        EngineKind::Mongo => {
            let mongo = input.mongo.as_mut().ok_or("MONGO_CONFIG_MISSING")?;
            maybe_persist_secret_ref(
                app,
                profile_id,
                EngineKind::Mongo,
                persist_secrets,
                &mut mongo.password,
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

fn build_sharing_export_file(
    app: &AppHandle,
    mut profiles: Vec<ConnectionProfile>,
    options: sharing::SharingExportOptions,
) -> Result<ProfileExportFile, String> {
    for profile in &mut profiles {
        sharing::prepare_profile_for_sharing_export(app, profile, &options)?;
    }

    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let secrets_redacted = !options.include_db_password && !options.include_ssh_password;

    Ok(ProfileExportFile {
        version: profile_store::profile_file_version(),
        exported_at,
        profiles,
        export_mode: Some("sharing".into()),
        secrets_redacted,
        sharing_checklist: sharing::sharing_checklist(&options),
        included_db_password: options.include_db_password,
        included_ssh_password: options.include_ssh_password,
    })
}

fn serialize_export_file(file: &ProfileExportFile) -> Result<String, String> {
    serde_json::to_string_pretty(file).map_err(|e| format!("PROFILE_EXPORT_SERIALIZE_FAILED: {e}"))
}

#[tauri::command]
pub fn profile_export(
    app: AppHandle,
    include_db_password: Option<bool>,
    include_ssh_password: Option<bool>,
) -> Result<String, String> {
    let profiles = profile_store::profile_list(&app)?;
    let options = sharing::SharingExportOptions {
        include_db_password: include_db_password.unwrap_or(false),
        include_ssh_password: include_ssh_password.unwrap_or(false),
    };
    let file = build_sharing_export_file(&app, profiles, options)?;
    serialize_export_file(&file)
}

#[tauri::command]
pub fn profile_export_one(
    app: AppHandle,
    profile_id: Uuid,
    include_db_password: Option<bool>,
    include_ssh_password: Option<bool>,
) -> Result<String, String> {
    let profile = profile_store::profile_get(&app, profile_id)?;
    let options = sharing::SharingExportOptions {
        include_db_password: include_db_password.unwrap_or(false),
        include_ssh_password: include_ssh_password.unwrap_or(false),
    };
    let file = build_sharing_export_file(&app, vec![profile], options)?;
    serialize_export_file(&file)
}

#[tauri::command]
pub fn profile_export_one_encrypted(
    app: AppHandle,
    profile_id: Uuid,
    password: String,
    include_db_password: Option<bool>,
    include_ssh_password: Option<bool>,
) -> Result<String, String> {
    let profile = profile_store::profile_get(&app, profile_id)?;
    let options = sharing::SharingExportOptions {
        include_db_password: include_db_password.unwrap_or(false),
        include_ssh_password: include_ssh_password.unwrap_or(false),
    };
    let file = build_sharing_export_file(&app, vec![profile], options)?;
    let plaintext = serialize_export_file(&file)?;
    export_crypto::encrypt_export_payload(&plaintext, &password)
}

#[tauri::command]
pub fn profile_decrypt_export(encrypted_json: String, password: String) -> Result<String, String> {
    export_crypto::decrypt_export_payload(&encrypted_json, &password)
}

#[tauri::command]
pub fn profile_is_encrypted_export(json: String) -> bool {
    export_crypto::is_encrypted_export(&json)
}

#[tauri::command]
pub fn profile_import(
    app: AppHandle,
    payload: ProfileImportPayload,
) -> Result<ProfileImportResult, String> {
    let json = payload.json.trim();
    if json.is_empty() {
        return Err("PROFILE_IMPORT_EMPTY".into());
    }

    let profiles = match serde_json::from_str::<ProfileExportFile>(json) {
        Ok(file) => file.profiles,
        Err(wrapper_err) => match serde_json::from_str::<Vec<ConnectionProfile>>(json) {
            Ok(list) => list,
            Err(list_err) => match serde_json::from_str::<ConnectionProfile>(json) {
                Ok(profile) => vec![profile],
                Err(one_err) => {
                    return Err(format!(
                        "PROFILE_IMPORT_INVALID_JSON: wrapper={wrapper_err}; list={list_err}; one={one_err}"
                    ))
                }
            },
        },
    };

    let (created, updated, profiles) = profile_store::profile_upsert_many(&app, profiles)?;
    let total = profiles.len();

    Ok(ProfileImportResult {
        created,
        updated,
        total,
        profiles,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileImportExternalPayload {
    pub path: String,
    pub password: Option<String>,
}

#[tauri::command]
pub fn profile_import_external(
    app: AppHandle,
    payload: ProfileImportExternalPayload,
) -> Result<ExternalImportResult, String> {
    import_external::import_external_file(&app, &payload.path, payload.password.as_deref())
}
