use async_trait::async_trait;
use mysql_async::Pool;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::mysql::{config::build_mysql_opts, connection::MySqlConn};
use crate::engines::EngineConnection;
use crate::security::secrets;
use crate::types::{ConnectionCreateInput, EngineKind, MySqlConnectInput, SecretRefKind};

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
        let conn = connect_mysql(app, conn_id, label, my).await?;
        Ok(EngineConnection::MySql(conn))
    }

    async fn test(&self, app: &AppHandle, input: ConnectionCreateInput) -> Result<(), String> {
        let my = input.mysql.ok_or("MYSQL_CONFIG_MISSING")?;
        test_mysql(app, my).await
    }
}

async fn resolve_password(
    app: &AppHandle,
    conn_id: Uuid,
    input: &MySqlConnectInput,
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

pub async fn connect_mysql(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: MySqlConnectInput,
) -> Result<MySqlConn, String> {
    let password = resolve_password(app, conn_id, &input).await?;

    let plan = build_mysql_opts(&input, &password).map_err(|e| e.to_string())?;

    // ✅ Pool must be created from Opts (primary/fallback), NOT from MysqlOptsPlan
    let mut pool = Pool::new(plan.primary);

    // smoke test function
    async fn smoke(pool: &Pool, input: &MySqlConnectInput) -> Result<(), String> {
        use mysql_async::prelude::Queryable;

        let mut conn = if let Some(ms) = input.connect_timeout_ms {
            if ms > 0 {
                tokio::time::timeout(std::time::Duration::from_millis(ms), pool.get_conn())
                    .await
                    .map_err(|_| "MYSQL_CONNECT_TIMEOUT".to_string())?
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

    // try primary
    let primary_ok = smoke(&pool, &input).await.is_ok();

    // if prefer + primary failed => retry fallback
    if !primary_ok {
        if let Some(fallback) = plan.fallback {
            pool = Pool::new(fallback);
            smoke(&pool, &input).await?; // fallback fail => real fail
        } else {
            smoke(&pool, &input).await?; // re-run to return the original error text
        }
    }

    Ok(MySqlConn {
        id: conn_id,
        label,
        pool,
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_mysql(app: &AppHandle, input: MySqlConnectInput) -> Result<(), String> {
    let _ = connect_mysql(app, Uuid::new_v4(), "__test__".into(), input).await?;
    Ok(())
}
