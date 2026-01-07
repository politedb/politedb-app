use std::time::Duration;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use deadpool_postgres::{Manager, Pool};
use tauri::AppHandle;
use tokio_postgres::NoTls;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::postgres::config::build_pg_config;
use crate::engines::postgres::connection::PgConn;
use crate::engines::EngineConnection;
use crate::security::secrets;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, PgConnectInput, SecretRef,
    SecretRefKind,
};

pub struct PostgresDriver;

#[async_trait]
impl EngineDriver for PostgresDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Postgres
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let pg = input.postgres.ok_or("POSTGRES_CONFIG_MISSING")?;

        let conn = connect_pg(app, conn_id, label, pg)
            .await
            .map_err(|e| format!("POSTGRES_CONNECT_FAILED: {:#}", e))?;

        Ok(EngineConnection::Postgres(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let pg = input.postgres.ok_or("POSTGRES_CONFIG_MISSING")?;

        test_pg_direct(app, pg, secrets.as_ref())
            .await
            .map_err(|e| format!("POSTGRES_TEST_FAILED: {:#}", e))?;

        Ok(())
    }
}

/* =============================================================================
 * Low-level connector
 * ============================================================================= */

async fn resolve_password_from_secret_ref(
    app: &AppHandle,
    secret: &SecretRef,
) -> anyhow::Result<String> {
    match secret.kind {
        SecretRefKind::Inline => Ok(secret.value.clone()),
        SecretRefKind::Keychain => {
            let key = secret.value.trim();
            if key.is_empty() {
                return Err(anyhow!("empty keychain key"));
            }

            let pw = secrets::keychain_get(app, key)
                .map_err(|e| anyhow!(e))
                .with_context(|| format!("keychain_get failed key={}", key))?;

            if pw.is_empty() {
                return Err(anyhow!(
                    "empty password retrieved from keychain key={}",
                    key
                ));
            }

            tracing::info!(
                step = "resolved_password_from_keychain",
                key = %key,
                "done"
            );

            Ok(pw)
        }
    }
}

/// TEST password policy:
/// - If secrets.db_password is Some(non-empty): use it (plain password for test)
/// - else: fallback to input.password (inline/keychain)
async fn resolve_password_for_test(
    app: &AppHandle,
    input_password: &SecretRef,
    secrets: Option<&ConnectionTestSecrets>,
) -> anyhow::Result<String> {
    if let Some(s) = secrets {
        if let Some(pw) = s.db_password.as_deref().map(str::trim) {
            if !pw.is_empty() {
                return Ok(pw.to_string());
            }
        }
    }

    resolve_password_from_secret_ref(app, input_password).await
}

pub async fn connect_pg(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: PgConnectInput,
) -> anyhow::Result<PgConn> {
    // connect uses stored secret ref (profile/runtime semantics)
    let password = resolve_password_from_secret_ref(app, &input.password).await?;

    let cfg = build_pg_config(&input, &password).context("build_pg_config failed")?;

    let mgr = Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig::default());

    let max_size: usize = input.pool_max_size.unwrap_or(10).clamp(1, 50);

    let pool = Pool::builder(mgr)
        .max_size(max_size)
        .build()
        .context("build pg pool failed")?;

    {
        let client = pool.get().await.context("pg pool get failed")?;
        client
            .simple_query("SELECT 1")
            .await
            .context("pg ping failed")?;
    }

    Ok(PgConn {
        id: conn_id,
        label,
        pool,
    })
}

/// Direct test (no pool). Uses plain password if provided.
async fn test_pg_direct(
    app: &AppHandle,
    input: PgConnectInput,
    secrets: Option<&ConnectionTestSecrets>,
) -> anyhow::Result<()> {
    let password = resolve_password_for_test(app, &input.password, secrets).await?;

    let cfg = build_pg_config(&input, &password).context("build_pg_config failed")?;

    let timeout_ms = input
        .connect_timeout_ms
        .unwrap_or(15_000)
        .clamp(500, 60_000);
    let timeout = Duration::from_millis(timeout_ms);

    let (client, connection) = tokio::time::timeout(timeout, cfg.connect(NoTls))
        .await
        .map_err(|_| anyhow!("pg connect timeout after {}ms", timeout_ms))?
        .context("pg connect failed")?;

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            tracing::debug!(error = %e, "pg connection task ended");
        }
    });

    tokio::time::timeout(timeout, client.simple_query("SELECT 1"))
        .await
        .map_err(|_| anyhow!("pg ping timeout after {}ms", timeout_ms))?
        .context("pg ping failed")?;

    Ok(())
}
