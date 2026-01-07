use std::time::Duration;

use async_trait::async_trait;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::redis::{config::build_redis_url, connection::RedisConn};
use crate::engines::EngineConnection;
use crate::security::secrets;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, RedisConnectInput, SecretRef,
    SecretRefKind,
};

pub struct RedisDriver;

#[async_trait]
impl EngineDriver for RedisDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Redis
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let rd = input.redis.ok_or("REDIS_CONFIG_MISSING")?;

        let conn = connect_redis(app, conn_id, label, rd)
            .await
            .map_err(|e| format!("REDIS_CONNECT_FAILED: {e}"))?;

        Ok(EngineConnection::Redis(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets_opt: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let rd = input.redis.ok_or("REDIS_CONFIG_MISSING")?;

        test_redis_direct(app, rd, secrets_opt)
            .await
            .map_err(|e| format!("REDIS_TEST_FAILED: {e}"))?;

        Ok(())
    }
}

/* =============================================================================
 * Secrets resolving
 * - Rule: For TEST, if caller provides plaintext secret in `secrets_opt`, use it.
 * - Otherwise, fall back to SecretRef (inline/keychain) in the input.
 * ============================================================================= */

async fn resolve_secret_ref(app: &AppHandle, secret: &SecretRef) -> Result<String, String> {
    match secret.kind {
        SecretRefKind::Inline => Ok(secret.value.clone()),
        SecretRefKind::Keychain => {
            let key = secret.value.trim();
            if key.is_empty() {
                return Err("EMPTY_KEYCHAIN_KEY".into());
            }
            let v = secrets::keychain_get(app, key).map_err(|e| e.to_string())?;
            if v.is_empty() {
                return Err("EMPTY_SECRET_FROM_KEYCHAIN".into());
            }
            Ok(v)
        }
    }
}

async fn resolve_redis_password_for_test(
    app: &AppHandle,
    input: &RedisConnectInput,
    secrets_opt: Option<&ConnectionTestSecrets>,
) -> Result<String, String> {
    if let Some(secrets) = secrets_opt {
        if let Some(pw) = secrets.db_password.as_deref() {
            return Ok(pw.to_string());
        }
    }
    resolve_secret_ref(app, &input.password).await
}

/* =============================================================================
 * Low-level connector
 * ============================================================================= */

fn validate_redis_input(input: &RedisConnectInput) -> Result<(), String> {
    if input.host.trim().is_empty() {
        return Err("REDIS_HOST_REQUIRED".into());
    }
    if input.port == 0 {
        return Err("REDIS_PORT_INVALID".into());
    }
    Ok(())
}

async fn ping_pool(pool: &deadpool_redis::Pool, timeout_ms: u64) -> Result<(), String> {
    use deadpool_redis::redis::AsyncCommands;

    let mut conn = pool
        .get()
        .await
        .map_err(|e| format!("REDIS_POOL_GET_FAILED: {e}"))?;

    let pong: String = tokio::time::timeout(Duration::from_millis(timeout_ms), conn.ping())
        .await
        .map_err(|_| format!("REDIS_PING_TIMEOUT after {timeout_ms}ms"))?
        .map_err(|e| format!("REDIS_PING_FAILED: {e}"))?;

    if pong.to_ascii_uppercase() != "PONG" {
        return Err("REDIS_PING_INVALID".into());
    }

    Ok(())
}

pub async fn connect_redis(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: RedisConnectInput,
) -> Result<RedisConn, String> {
    validate_redis_input(&input)?;

    // connect path: always respect SecretRef (inline/keychain) from saved profile input
    let password = resolve_secret_ref(app, &input.password).await?;
    if password.trim().is_empty() {
        return Err("REDIS_PASSWORD_REQUIRED".into());
    }

    // Build URL (no logging)
    let url = build_redis_url(&input, &password).map_err(|e| e.to_string())?;

    // deadpool_redis config
    let mut cfg = deadpool_redis::Config::from_url(url);

    let max_size = input.pool_max_size.unwrap_or(10).clamp(1, 50);
    cfg.pool = Some(deadpool_redis::PoolConfig::new(max_size));

    let pool = cfg
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .map_err(|e| format!("REDIS_CREATE_POOL_FAILED: {e}"))?;

    // Smoke test: PING (timeout from input)
    let timeout_ms = input.connect_timeout_ms.unwrap_or(5_000).clamp(100, 60_000);
    ping_pool(&pool, timeout_ms).await?;

    Ok(RedisConn {
        id: conn_id,
        label,
        pool,
        default_command_timeout_ms: input.connect_timeout_ms,
    })
}

pub async fn test_redis_direct(
    app: &AppHandle,
    input: RedisConnectInput,
    secrets_opt: Option<ConnectionTestSecrets>,
) -> Result<(), String> {
    validate_redis_input(&input)?;

    // test path: allow plaintext password override from frontend
    let password = resolve_redis_password_for_test(app, &input, secrets_opt.as_ref()).await?;
    if password.trim().is_empty() {
        return Err("REDIS_PASSWORD_REQUIRED".into());
    }

    let url = build_redis_url(&input, &password).map_err(|e| e.to_string())?;

    let mut cfg = deadpool_redis::Config::from_url(url);

    // For test we can keep it small; still allow custom max if you want
    let max_size = input.pool_max_size.unwrap_or(3).clamp(1, 20);
    cfg.pool = Some(deadpool_redis::PoolConfig::new(max_size));

    let pool = cfg
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .map_err(|e| format!("REDIS_CREATE_POOL_FAILED: {e}"))?;

    let timeout_ms = input.connect_timeout_ms.unwrap_or(5_000).clamp(100, 60_000);
    ping_pool(&pool, timeout_ms).await?;

    Ok(())
}
