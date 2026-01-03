use anyhow::Context;
use deadpool_postgres::{Manager, Pool};
use tokio_postgres::{Config, NoTls};
use uuid::Uuid;

use crate::security::secrets;
use crate::types::{PgConnectInput, SecretRefKind};

use super::PgConn;

fn build_pg_config(i: &PgConnectInput, password: &str) -> anyhow::Result<Config> {
    let mut cfg = Config::new();
    cfg.host(&i.host);
    cfg.port(i.port);
    cfg.dbname(&i.database);
    cfg.user(&i.user);
    cfg.password(password);

    if let Some(ms) = i.connect_timeout_ms {
        cfg.connect_timeout(std::time::Duration::from_millis(ms));
    }

    Ok(cfg)
}

async fn resolve_password(conn_id: Uuid, i: &PgConnectInput) -> anyhow::Result<String> {
    match i.password.kind {
        SecretRefKind::Inline => Ok(i.password.value.clone()),
        SecretRefKind::Keychain => {
            let key = i.password.value.clone();
            let pw = secrets::keychain_get(&key)
                .with_context(|| format!("keychain_get failed for conn_id={}", conn_id))?;
            Ok(pw)
        }
    }
}

pub async fn connect_pg(
    conn_id: Uuid,
    label: String,
    input: PgConnectInput,
) -> anyhow::Result<PgConn> {
    let password = resolve_password(conn_id, &input).await?;

    let cfg = build_pg_config(&input, &password)?;

    // TLS: nếu bạn bật feature pg-tls thì có thể build connector ở đây.
    // Hiện tại NoTls để đơn giản; khi bạn muốn SSL require, mình sẽ đưa bản pg-tls chuẩn.
    let mgr = Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig::default());
    let pool = Pool::builder(mgr)
        .max_size(10)
        .build()
        .context("build pg pool failed")?;

    // Smoke test: lấy 1 client ping nhẹ
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
