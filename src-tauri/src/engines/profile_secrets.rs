use tauri::AppHandle;
use uuid::Uuid;

use crate::security::secrets;
use crate::types::{EngineKind, SecretRef, SecretRefKind};

fn engine_key(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Postgres => "postgres",
        EngineKind::Mysql => "mysql",
        EngineKind::Mariadb => "mariadb",
        EngineKind::Sqlserver => "sqlserver",
        EngineKind::Sqlite => "sqlite",
        EngineKind::Duckdb => "duckdb",
        EngineKind::D1 => "d1",
        EngineKind::Turso => "turso",
        EngineKind::Oracle => "oracle",
        EngineKind::Mongo => "mongo",
        EngineKind::Cassandra => "cassandra",
        EngineKind::Redis => "redis",
        EngineKind::Snowflake => "snowflake",
        EngineKind::Clickhouse => "clickhouse",
    }
}

pub fn keychain_key_for_profile(profile_id: Uuid, engine: EngineKind) -> String {
    format!("profile:{profile_id}:{}:password", engine_key(engine))
}

/// Inline password/token → keychain reference when `persist_secrets` is enabled.
pub fn persist_secret_ref(
    app: &AppHandle,
    profile_id: Uuid,
    engine: EngineKind,
    persist_secrets: bool,
    sr: &mut SecretRef,
) -> Result<(), String> {
    if !persist_secrets {
        return Ok(());
    }

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
