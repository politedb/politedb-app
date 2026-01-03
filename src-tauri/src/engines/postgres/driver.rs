use anyhow::{anyhow, Context};
use async_trait::async_trait;
use deadpool_postgres::{Manager, Pool};
use tauri::AppHandle;
use tokio_postgres::NoTls;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::EngineConnection;

use crate::engines::postgres::config::build_pg_config;
use crate::engines::postgres::connection::PgConn;
use crate::security::secrets;
use crate::types::{ConnectionCreateInput, EngineKind, PgConnectInput, SecretRefKind};

/* =============================================================================
 * High-level driver for registry
 * ============================================================================= */

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

    async fn test(&self, app: &AppHandle, input: ConnectionCreateInput) -> Result<(), String> {
        let pg = input.postgres.ok_or("POSTGRES_CONFIG_MISSING")?;

        test_pg(app, pg)
            .await
            .map_err(|e| format!("POSTGRES_TEST_FAILED: {:#}", e))?;

        Ok(())
    }
}

/* =============================================================================
 * Low-level connector (your original driver)
 * ============================================================================= */

async fn resolve_password(
    app: &AppHandle,
    conn_id: Uuid,
    i: &PgConnectInput,
) -> anyhow::Result<String> {
    match i.password.kind {
        SecretRefKind::Inline => Ok(i.password.value.clone()),

        SecretRefKind::Keychain => {
            let key = i.password.value.trim();
            if key.is_empty() {
                return Err(anyhow!("empty keychain key for conn_id={}", conn_id));
            }

            let pw = secrets::keychain_get(app, key)
                .map_err(|e| anyhow!(e))
                .with_context(|| {
                    format!("keychain_get failed for conn_id={} key={}", conn_id, key)
                })?;

            if pw.is_empty() {
                return Err(anyhow!(
                    "empty password retrieved from keychain for conn_id={} key={}",
                    conn_id,
                    key
                ));
            }

            Ok(pw)
        }
    }
}

pub async fn connect_pg(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: PgConnectInput,
) -> anyhow::Result<PgConn> {
    // 1) Resolve password (inline or keychain)
    let password = resolve_password(app, conn_id, &input).await?;

    // 2) Build config WITHOUT logging password
    let cfg = build_pg_config(&input, &password).context("build_pg_config failed")?;

    // 3) Manager + pool
    let mgr = Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig::default());

    // 4) Pool size tuning
    let max_size: usize = input.pool_max_size.unwrap_or(10).clamp(1, 50);

    let pool = Pool::builder(mgr)
        .max_size(max_size)
        .build()
        .context("build pg pool failed")?;

    // 5) Smoke test
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

/// Optional helper for "test connection" flow (no state mutation)
pub async fn test_pg(app: &AppHandle, input: PgConnectInput) -> anyhow::Result<()> {
    let _ = connect_pg(app, Uuid::new_v4(), "__test__".into(), input).await?;
    Ok(())
}
