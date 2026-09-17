use std::time::Duration;

use async_trait::async_trait;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::redis::{config::build_redis_url, connection::RedisConn};
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::EngineConnection;
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

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        // common ssh merge (engine-agnostic)
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.redis.ok_or("REDIS_CONFIG_MISSING")?;

        if let Some(ov_rd) = ov.redis {
            b = merge_redis(b, ov_rd, &secrets);
        } else {
            // even if no override, secrets may force inline pw for test
            if let Some(pw) = inline_db_pw(&secrets) {
                b.password = SecretRef {
                    kind: SecretRefKind::Inline,
                    value: pw,
                };
            }
        }

        base.redis = Some(b);
        Ok(base)
    }
    fn persist_profile_secrets(
        &self,
        app: &AppHandle,
        profile_id: uuid::Uuid,
        persist_secrets: bool,
        mut input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        let r = input.redis.as_mut().ok_or("REDIS_CONFIG_MISSING")?;
        crate::engines::profile_secrets::persist_secret_ref(
            app,
            profile_id,
            EngineKind::Redis,
            persist_secrets,
            &mut r.password,
        )?;
        Ok(input)
    }
}

/* =============================================================================
 * Merge helpers (engine-specific)
 * ============================================================================= */

fn merge_redis(
    mut base: RedisConnectInput,
    ov: RedisConnectInput,
    secrets: &Option<ConnectionTestSecrets>,
) -> RedisConnectInput {
    base.host = ov.host;
    base.port = ov.port;
    base.user = ov.user;
    base.db = ov.db;

    base.ssl_mode = ov.ssl_mode;
    base.connect_timeout_ms = ov.connect_timeout_ms;

    // password policy for test:
    // secrets.db_password (inline) > ov.password (inline non-empty) > base.password (usually keychain)
    let inline = inline_db_pw(secrets);
    merge_secret_ref_for_test(&mut base.password, &ov.password, inline.as_ref());

    base
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

    if !pong.eq_ignore_ascii_case("PONG") {
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

    // connect path: ALWAYS respect SecretRef (inline/keychain)
    let password = resolve_secret_ref(app, &input.password).await?;
    if password.trim().is_empty() {
        return Err("REDIS_PASSWORD_REQUIRED".into());
    }

    let url = build_redis_url(&input, &password).map_err(|e| e.to_string())?;

    let mut cfg = deadpool_redis::Config::from_url(url);

    let max_size = input.pool_max_size.unwrap_or(5).clamp(1, 20);
    cfg.pool = Some(deadpool_redis::PoolConfig::new(max_size));

    let pool = cfg
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .map_err(|e| format!("REDIS_CREATE_POOL_FAILED: {e}"))?;

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

    // test path: allow plaintext override
    let override_plain = secrets_opt.as_ref().and_then(|s| s.db_password.as_deref());

    let password = resolve_secret_ref_for_test(app, &input.password, override_plain).await?;
    if password.trim().is_empty() {
        return Err("REDIS_PASSWORD_REQUIRED".into());
    }

    let url = build_redis_url(&input, &password).map_err(|e| e.to_string())?;

    let mut cfg = deadpool_redis::Config::from_url(url);

    let max_size = input.pool_max_size.unwrap_or(3).clamp(1, 20);
    cfg.pool = Some(deadpool_redis::PoolConfig::new(max_size));

    let pool = cfg
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .map_err(|e| format!("REDIS_CREATE_POOL_FAILED: {e}"))?;

    let timeout_ms = input.connect_timeout_ms.unwrap_or(5_000).clamp(100, 60_000);
    ping_pool(&pool, timeout_ms).await?;

    Ok(())
}
