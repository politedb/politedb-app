use std::time::Duration;

use async_trait::async_trait;
use mysql_async::{prelude::Queryable, Pool};
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::mysql::{config::build_mysql_opts, connection::MySqlConn};
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::EngineConnection;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, MySqlConnectInput, SecretRef,
    SecretRefKind,
};
pub struct MySqlDriver;
pub struct MariaDbDriver;

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

        let conn = connect_mysql(app, conn_id, label, EngineKind::Mysql, my)
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

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        // common ssh merge (engine-agnostic)
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.mysql.ok_or("MYSQL_CONFIG_MISSING")?;

        if let Some(ov_my) = ov.mysql {
            b = merge_mysql(b, ov_my, &secrets);
        } else {
            // even if no override, secrets may force inline pw for test
            if let Some(pw) = inline_db_pw(&secrets) {
                b.password = SecretRef {
                    kind: SecretRefKind::Inline,
                    value: pw,
                };
            }
        }

        base.mysql = Some(b);
        Ok(base)
    }
    fn persist_profile_secrets(
        &self,
        app: &AppHandle,
        profile_id: uuid::Uuid,
        persist_secrets: bool,
        mut input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        let my = input.mysql.as_mut().ok_or("MYSQL_CONFIG_MISSING")?;
        crate::engines::profile_secrets::persist_secret_ref(
            app,
            profile_id,
            self.kind(),
            persist_secrets,
            &mut my.password,
        )?;
        Ok(input)
    }
}

#[async_trait]
impl EngineDriver for MariaDbDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Mariadb
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let my = input.mysql.ok_or("MYSQL_CONFIG_MISSING")?;

        let conn = connect_mysql(app, conn_id, label, EngineKind::Mariadb, my)
            .await
            .map_err(|e| format!("MARIADB_CONNECT_FAILED: {e}"))?;

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
            .map_err(|e| format!("MARIADB_TEST_FAILED: {e}"))?;

        Ok(())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.mysql.ok_or("MYSQL_CONFIG_MISSING")?;

        if let Some(ov_my) = ov.mysql {
            b = merge_mysql(b, ov_my, &secrets);
        } else if let Some(pw) = inline_db_pw(&secrets) {
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.mysql = Some(b);
        Ok(base)
    }
    fn persist_profile_secrets(
        &self,
        app: &AppHandle,
        profile_id: uuid::Uuid,
        persist_secrets: bool,
        mut input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        let my = input.mysql.as_mut().ok_or("MYSQL_CONFIG_MISSING")?;
        crate::engines::profile_secrets::persist_secret_ref(
            app,
            profile_id,
            self.kind(),
            persist_secrets,
            &mut my.password,
        )?;
        Ok(input)
    }
}

/* =============================================================================
 * Merge helpers (engine-specific)
 * ============================================================================= */

fn merge_mysql(
    mut base: MySqlConnectInput,
    ov: MySqlConnectInput,
    secrets: &Option<ConnectionTestSecrets>,
) -> MySqlConnectInput {
    // core identity
    base.host = ov.host;
    base.port = ov.port;
    base.user = ov.user;
    base.database = ov.database;

    // options
    base.ssl_mode = ov.ssl_mode;
    base.connect_timeout_ms = ov.connect_timeout_ms;
    base.statement_timeout_ms = ov.statement_timeout_ms;
    base.pool_max_size = ov.pool_max_size;
    base.ssl_key_path = ov.ssl_key_path;
    base.ssl_cert_path = ov.ssl_cert_path;
    base.ssl_ca_path = ov.ssl_ca_path;

    // password policy for test:
    // secrets.db_password (inline) > ov.password (inline non-empty) > base.password (usually keychain)
    let inline = inline_db_pw(secrets);
    merge_secret_ref_for_test(&mut base.password, &ov.password, inline.as_ref());

    base
}

/* =============================================================================
 * Low-level connector
 * ============================================================================= */

async fn smoke_mysql(pool: &Pool, input: &MySqlConnectInput) -> Result<(), String> {
    let timeout_ms = input
        .connect_timeout_ms
        .unwrap_or(15_000)
        .clamp(200, 60_000);

    let mut conn = tokio::time::timeout(Duration::from_millis(timeout_ms), pool.get_conn())
        .await
        .map_err(|_| format!("MYSQL_CONNECT_TIMEOUT after {timeout_ms}ms"))?
        .map_err(|e| e.to_string())?;

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
    engine: EngineKind,
    input: MySqlConnectInput,
) -> Result<MySqlConn, String> {
    // connect path: ALWAYS resolve from SecretRef (inline/keychain)
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
        engine,
        pool,
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_mysql_direct(
    app: &AppHandle,
    input: MySqlConnectInput,
    secrets_opt: Option<ConnectionTestSecrets>,
) -> Result<(), String> {
    // test path: allow plaintext override
    let override_plain = secrets_opt.as_ref().and_then(|s| s.db_password.as_deref());

    let password = resolve_secret_ref_for_test(app, &input.password, override_plain).await?;
    let plan = build_mysql_opts(&input, &password).map_err(|e| e.to_string())?;

    // primary test
    let pool = Pool::new(plan.primary);
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
