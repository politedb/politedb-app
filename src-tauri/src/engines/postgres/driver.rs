use std::time::Duration;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use deadpool_postgres::{Manager, Pool};
use tauri::AppHandle;
use tokio_postgres::NoTls;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::postgres::config::build_pg_config;
use crate::engines::postgres::connection::PgConn;
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::EngineConnection;
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

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        // 1) Common: SSH merge (handles ssh_password via secrets when auth=Password)
        base = merge_ssh_for_test(base, &ov, &secrets);

        // 2) Engine specific: Postgres merge
        let mut b = base.postgres.ok_or("POSTGRES_CONFIG_MISSING")?;

        if let Some(pov) = ov.postgres {
            b = merge_pg_for_test(b, pov, &secrets);
        } else if let Some(pw) = inline_db_pw(&secrets) {
            // Even without override struct, secrets can still force plain password for test
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.postgres = Some(b);
        Ok(base)
    }
}

/* =============================================================================
 * Postgres: merge policy (test)
 * ============================================================================= */

fn merge_pg_for_test(
    mut base: PgConnectInput,
    ov: PgConnectInput,
    secrets: &Option<ConnectionTestSecrets>,
) -> PgConnectInput {
    // connection fields always override
    base.host = ov.host;
    base.port = ov.port;
    base.user = ov.user;
    base.database = ov.database;

    // optional tunables override (FE controls)
    base.ssl_mode = ov.ssl_mode;
    base.connect_timeout_ms = ov.connect_timeout_ms;
    base.statement_timeout_ms = ov.statement_timeout_ms;
    base.ssl_key_path = ov.ssl_key_path;
    base.ssl_cert_path = ov.ssl_cert_path;
    base.ssl_ca_path = ov.ssl_ca_path;
    base.pool_max_size = ov.pool_max_size;

    // password merge order:
    // 1) secrets.db_password (plain) if provided
    // 2) ov.password if it is meaningful (helper decides)
    // 3) else keep base.password (usually keychain)
    let inline = inline_db_pw(secrets);
    merge_secret_ref_for_test(&mut base.password, &ov.password, inline.as_ref());

    base
}

/* =============================================================================
 * Connect (pool)
 * ============================================================================= */

pub async fn connect_pg(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: PgConnectInput,
) -> anyhow::Result<PgConn> {
    // Connect MUST use stored secret ref (profile/runtime semantics)
    let password = resolve_secret_ref(app, &input.password)
        .await
        .map_err(|e| anyhow!("{e}"))?;

    // Build config WITHOUT logging password
    let cfg = build_pg_config(&input, &password).context("build_pg_config failed")?;

    let mgr = Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig::default());

    let max_size: usize = input.pool_max_size.unwrap_or(10).clamp(1, 50);

    let pool = Pool::builder(mgr)
        .max_size(max_size)
        .build()
        .context("build pg pool failed")?;

    // Smoke test
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

/* =============================================================================
 * Test (direct, no pool)
 * ============================================================================= */

async fn test_pg_direct(
    app: &AppHandle,
    input: PgConnectInput,
    secrets: Option<&ConnectionTestSecrets>,
) -> anyhow::Result<()> {
    let override_plain = secrets.and_then(|s| s.db_password.as_deref());

    let password = resolve_secret_ref_for_test(app, &input.password, override_plain)
        .await
        .map_err(|e| anyhow!("{e}"))?;
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

    // Drive connection in background
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
