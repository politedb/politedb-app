use std::time::Duration;

use async_trait::async_trait;
use mysql_async::{prelude::Queryable, Pool};
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::mysql::{config::build_mysql_opts, connection::MySqlConn};
use crate::engines::EngineConnection;
use crate::security::secrets;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, MySqlConnectInput, SecretRef,
    SecretRefKind,
};

pub struct MySqlDriver;

#[async_trait]
impl EngineDriver for MySqlDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Mysql
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let my = input.mysql.ok_or("MYSQL_CONFIG_MISSING")?;

        let conn = connect_mysql(app, conn_id, label, my)
            .await
            .map_err(|e| format!("MYSQL_CONNECT_FAILED: {e}"))?;

        Ok(EngineConnection::MySql(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets_opt: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let my = input.mysql.ok_or("MYSQL_CONFIG_MISSING")?;

        test_mysql_direct(app, my, secrets_opt)
            .await
            .map_err(|e| format!("MYSQL_TEST_FAILED: {e}"))?;

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

async fn resolve_mysql_password_for_test(
    app: &AppHandle,
    input: &MySqlConnectInput,
    secrets_opt: Option<&ConnectionTestSecrets>,
) -> Result<String, String> {
    if let Some(secrets) = secrets_opt {
        if let Some(pw) = secrets.db_password.as_deref() {
            // Plain password provided by caller (test-only)
            return Ok(pw.to_string());
        }
    }
    // Fallback to input secret ref (inline/keychain)
    resolve_secret_ref(app, &input.password).await
}

/* =============================================================================
 * Low-level connector
 * ============================================================================= */

async fn smoke_mysql(pool: &Pool, input: &MySqlConnectInput) -> Result<(), String> {
    let mut conn = if let Some(ms) = input.connect_timeout_ms {
        if ms > 0 {
            tokio::time::timeout(Duration::from_millis(ms), pool.get_conn())
                .await
                .map_err(|_| format!("MYSQL_CONNECT_TIMEOUT after {ms}ms"))?
                .map_err(|e| e.to_string())?
        } else {
            pool.get_conn().await.map_err(|e| e.to_string())?
        }
    } else {
        pool.get_conn().await.map_err(|e| e.to_string())?
    };

    if let Some(ms) = input.statement_timeout_ms {
        let ms = ms.clamp(100, 300_000);
        let _ = conn
            .query_drop(format!("SET SESSION max_execution_time = {}", ms))
            .await;
    }

    conn.query_drop("SELECT 1")
        .await
        .map_err(|e| e.to_string())?;

    let _ = conn.disconnect().await;
    Ok(())
}

pub async fn connect_mysql(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: MySqlConnectInput,
) -> Result<MySqlConn, String> {
    // connect path: always respect SecretRef (inline/keychain) from saved profile input
    let password = resolve_secret_ref(app, &input.password).await?;
    let plan = build_mysql_opts(&input, &password).map_err(|e| e.to_string())?;

    let mut pool = Pool::new(plan.primary);

    match smoke_mysql(&pool, &input).await {
        Ok(_) => {}
        Err(primary_err) => {
            if let Some(fallback) = plan.fallback {
                let pool2 = Pool::new(fallback);
                match smoke_mysql(&pool2, &input).await {
                    Ok(_) => pool = pool2,
                    Err(fallback_err) => {
                        return Err(format!(
                            "MYSQL_CONNECT_FAILED: primary={primary_err}; fallback={fallback_err}"
                        ));
                    }
                }
            } else {
                return Err(format!("MYSQL_CONNECT_FAILED: {primary_err}"));
            }
        }
    }

    Ok(MySqlConn {
        id: conn_id,
        label,
        pool,
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_mysql_direct(
    app: &AppHandle,
    input: MySqlConnectInput,
    secrets_opt: Option<ConnectionTestSecrets>,
) -> Result<(), String> {
    // test path: allow plaintext password override from frontend
    let password = resolve_mysql_password_for_test(app, &input, secrets_opt.as_ref()).await?;

    let plan = build_mysql_opts(&input, &password).map_err(|e| e.to_string())?;

    // Keep test lightweight (no need to keep pool around)
    let pool = Pool::new(plan.primary);

    // If primary fails and fallback exists, try fallback
    match smoke_mysql(&pool, &input).await {
        Ok(_) => Ok(()),
        Err(primary_err) => {
            if let Some(fallback) = plan.fallback {
                let pool2 = Pool::new(fallback);
                smoke_mysql(&pool2, &input).await.map_err(|fallback_err| {
                    format!("MYSQL_TEST_FAILED: primary={primary_err}; fallback={fallback_err}")
                })?;
                Ok(())
            } else {
                Err(format!("MYSQL_TEST_FAILED: {primary_err}"))
            }
        }
    }
}
