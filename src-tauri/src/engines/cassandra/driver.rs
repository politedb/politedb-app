use std::sync::Arc;

use async_trait::async_trait;
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::cassandra::connection::CassandraConn;
use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::EngineConnection;
use crate::types::{
    CassandraConnectInput, ConnectionCreateInput, ConnectionTestSecrets, EngineKind, SecretRef,
    SecretRefKind,
};

pub struct CassandraDriver;

#[async_trait]
impl EngineDriver for CassandraDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Cassandra
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let cfg = input.cassandra.ok_or("CASSANDRA_CONFIG_MISSING")?;
        let session = connect_cassandra(app, &cfg).await?;

        Ok(EngineConnection::Cassandra(CassandraConn {
            id: conn_id,
            label,
            session: Arc::new(session),
            default_keyspace: sanitize_opt(&cfg.keyspace),
        }))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets_opt: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let cfg = input.cassandra.ok_or("CASSANDRA_CONFIG_MISSING")?;
        test_cassandra_direct(app, cfg, secrets_opt).await
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.cassandra.ok_or("CASSANDRA_CONFIG_MISSING")?;

        if let Some(ov_cfg) = ov.cassandra {
            b.host = ov_cfg.host;
            b.port = ov_cfg.port;
            b.keyspace = ov_cfg.keyspace;
            b.user = ov_cfg.user;
            b.ssl_mode = ov_cfg.ssl_mode;
            b.connect_timeout_ms = ov_cfg.connect_timeout_ms;

            let inline = inline_db_pw(&secrets);
            merge_secret_ref_for_test(&mut b.password, &ov_cfg.password, inline.as_ref());
        } else if let Some(pw) = inline_db_pw(&secrets) {
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.cassandra = Some(b);
        Ok(base)
    }
}

fn sanitize_opt(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn node_address(input: &CassandraConnectInput) -> String {
    format!("{}:{}", input.host.trim(), input.port)
}

async fn resolve_cassandra_password(
    app: &AppHandle,
    secret_ref: &SecretRef,
    override_plain: Option<&str>,
) -> Result<String, String> {
    if let Some(pw) = override_plain {
        return Ok(pw.to_string());
    }

    match secret_ref.kind {
        SecretRefKind::Inline => Ok(secret_ref.value.clone()),
        SecretRefKind::Keychain => {
            let key = secret_ref.value.trim();
            if key.is_empty() {
                return Ok(String::new());
            }
            crate::security::secrets::keychain_get(app, key).map_err(|e| {
                if e == "KEYCHAIN_ITEM_NOT_FOUND" {
                    "CREDENTIALS_INVALID".to_string()
                } else {
                    e
                }
            })
        }
    }
}

async fn build_session(input: &CassandraConnectInput, password: &str) -> Result<Session, String> {
    let mut builder = SessionBuilder::new().known_node(node_address(input));

    if let Some(user) = sanitize_opt(&input.user) {
        builder = builder.user(user, password);
    }

    if let Some(ms) = input.connect_timeout_ms {
        let ms = ms.clamp(200, 60_000);
        builder = builder.connection_timeout(std::time::Duration::from_millis(ms));
    }

    builder
        .build()
        .await
        .map_err(|e| format!("CASSANDRA_CONNECT_FAILED: {e}"))
}

async fn smoke_cassandra(session: &Session, keyspace: Option<&str>) -> Result<(), String> {
    if let Some(ks) = keyspace.filter(|s| !s.is_empty()) {
        let stmt = format!("USE {ks}");
        session
            .query_unpaged(stmt, &[])
            .await
            .map_err(|e| format!("CASSANDRA_USE_KEYSPACE_FAILED: {e}"))?;
    }

    session
        .query_unpaged("SELECT release_version FROM system.local", &[])
        .await
        .map_err(|e| format!("CASSANDRA_CONNECT_FAILED: {e}"))?;

    Ok(())
}

async fn connect_cassandra(
    app: &AppHandle,
    input: &CassandraConnectInput,
) -> Result<Session, String> {
    let password = resolve_cassandra_password(app, &input.password, None).await?;
    let session = build_session(input, &password).await?;
    smoke_cassandra(&session, sanitize_opt(&input.keyspace).as_deref()).await?;
    Ok(session)
}

async fn test_cassandra_direct(
    app: &AppHandle,
    input: CassandraConnectInput,
    secrets_opt: Option<ConnectionTestSecrets>,
) -> Result<(), String> {
    let override_plain = secrets_opt
        .as_ref()
        .and_then(|s| s.db_password.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let password = resolve_cassandra_password(app, &input.password, override_plain).await?;
    let session = build_session(&input, &password).await?;
    smoke_cassandra(&session, sanitize_opt(&input.keyspace).as_deref()).await
}
