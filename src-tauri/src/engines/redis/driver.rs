use async_trait::async_trait;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::redis::{config::build_redis_url, connection::RedisConn};
use crate::engines::EngineConnection;
use crate::security::secrets;
use crate::types::{ConnectionCreateInput, EngineKind, RedisConnectInput, SecretRefKind};

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
        let conn = connect_redis(app, conn_id, label, rd).await?;
        Ok(EngineConnection::Redis(conn))
    }

    async fn test(&self, app: &AppHandle, input: ConnectionCreateInput) -> Result<(), String> {
        let rd = input.redis.ok_or("REDIS_CONFIG_MISSING")?;
        test_redis(app, rd).await
    }
}

async fn resolve_password(
    app: &AppHandle,
    conn_id: Uuid,
    input: &RedisConnectInput,
) -> Result<String, String> {
    match input.password.kind {
        SecretRefKind::Inline => Ok(input.password.value.clone()),
        SecretRefKind::Keychain => {
            let key = input.password.value.trim();
            if key.is_empty() {
                return Err(format!("EMPTY_KEYCHAIN_KEY: conn_id={conn_id}"));
            }
            let pw = secrets::keychain_get(app, key).map_err(|e| e.to_string())?;
            if pw.is_empty() {
                return Err("EMPTY_PASSWORD_FROM_KEYCHAIN".into());
            }
            Ok(pw)
        }
    }
}

pub async fn connect_redis(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: RedisConnectInput,
) -> Result<RedisConn, String> {
    // Validate basics
    if input.host.trim().is_empty() {
        return Err("REDIS_HOST_REQUIRED".into());
    }
    if input.port == 0 {
        return Err("REDIS_PORT_INVALID".into());
    }

    let password = resolve_password(app, conn_id, &input).await?;
    if password.trim().is_empty() {
        return Err("REDIS_PASSWORD_REQUIRED".into());
    }

    // Build URL (no logging)
    let url = build_redis_url(&input, &password).map_err(|e| e.to_string())?;

    // deadpool_redis config
    let mut cfg = deadpool_redis::Config::from_url(url);

    // Pool size
    let max_size = input.pool_max_size.unwrap_or(10).clamp(1, 50);
    cfg.pool = Some(deadpool_redis::PoolConfig::new(max_size));

    let pool = cfg
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .map_err(|e| format!("REDIS_CREATE_POOL_FAILED: {e}"))?;

    // Smoke test: PING
    {
        use deadpool_redis::redis::AsyncCommands;

        let mut conn = pool
            .get()
            .await
            .map_err(|e| format!("REDIS_POOL_GET_FAILED: {e}"))?;

        let timeout_ms = input.connect_timeout_ms.unwrap_or(5_000).clamp(100, 60_000);
        let pong: String =
            tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), conn.ping())
                .await
                .map_err(|_| "REDIS_PING_TIMEOUT".to_string())?
                .map_err(|e| format!("REDIS_PING_FAILED: {e}"))?;

        if pong.to_ascii_uppercase() != "PONG" {
            return Err("REDIS_PING_INVALID".into());
        }
    }

    Ok(RedisConn {
        id: conn_id,
        label,
        pool,
        default_command_timeout_ms: input.connect_timeout_ms,
    })
}

pub async fn test_redis(app: &AppHandle, input: RedisConnectInput) -> Result<(), String> {
    let _ = connect_redis(app, Uuid::new_v4(), "__test__".into(), input).await?;
    Ok(())
}
