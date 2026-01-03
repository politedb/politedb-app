use anyhow::{anyhow, Context};
use deadpool_postgres::{Manager, Pool};
use tauri::AppHandle;
use tokio_postgres::NoTls;
use uuid::Uuid;

use crate::engines::postgres::config::build_pg_config;
use crate::engines::postgres::PgConn;
use crate::security::secrets;
use crate::types::{PgConnectInput, SecretRefKind};

async fn resolve_password(
    app: &AppHandle,
    conn_id: Uuid,
    i: &PgConnectInput,
) -> anyhow::Result<String> {
    match i.password.kind {
        SecretRefKind::Inline => {
            // Keep inline secret in memory only
            Ok(i.password.value.clone())
        }
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
    // Resolve password (inline or keychain)
    let password = resolve_password(app, conn_id, &input).await?;

    // Build config WITHOUT logging password
    let cfg = build_pg_config(&input, &password)?;

    // Manager + pool
    let mgr = Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig::default());

    // Pool size: allow tuning via input (fallback = 10)
    let max_size: usize = input.pool_max_size.unwrap_or(10).clamp(1, 50) as usize;

    let pool = Pool::builder(mgr)
        .max_size(max_size)
        .build()
        .context("build pg pool failed")?;

    // Smoke test: minimal ping to catch wrong host/port/auth early
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
