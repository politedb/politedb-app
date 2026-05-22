use std::time::Duration;

use async_trait::async_trait;
use clickhouse::{Client, Row};
use serde::Deserialize;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::clickhouse::config::build_client;
use crate::engines::clickhouse::connection::ClickhouseConn;
use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::EngineConnection;
use crate::types::{
    ClickhouseConnectInput, ConnectionCreateInput, ConnectionTestSecrets, EngineKind, SecretRef,
    SecretRefKind,
};

pub struct ClickhouseDriver;

#[derive(Row, Deserialize)]
struct PingRow {
    #[allow(dead_code)]
    result: u8,
}

#[async_trait]
impl EngineDriver for ClickhouseDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Clickhouse
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let ch = input.clickhouse.ok_or("CLICKHOUSE_CONFIG_MISSING")?;
        let password = resolve_secret_ref(app, &ch.password).await?;
        let conn = connect_clickhouse(conn_id, label, ch, password)
            .await
            .map_err(|e| format!("CLICKHOUSE_CONNECT_FAILED: {e}"))?;
        Ok(EngineConnection::Clickhouse(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let ch = input.clickhouse.ok_or("CLICKHOUSE_CONFIG_MISSING")?;
        let override_plain = secrets.as_ref().and_then(|s| s.db_password.as_deref());
        let password = resolve_secret_ref_for_test(app, &ch.password, override_plain).await?;
        test_clickhouse_direct(ch, password)
            .await
            .map_err(|e| format!("CLICKHOUSE_TEST_FAILED: {e}"))?;
        Ok(())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base
            .clickhouse
            .or(ov.clickhouse.clone())
            .ok_or("CLICKHOUSE_CONFIG_MISSING")?;

        if let Some(ov_ch) = ov.clickhouse {
            b.host = ov_ch.host;
            b.port = ov_ch.port;
            b.user = ov_ch.user;
            b.database = ov_ch.database;
            b.ssl_mode = ov_ch.ssl_mode;
            b.connect_timeout_ms = ov_ch.connect_timeout_ms;
            b.statement_timeout_ms = ov_ch.statement_timeout_ms;

            let inline = inline_db_pw(&secrets);
            merge_secret_ref_for_test(&mut b.password, &ov_ch.password, inline.as_ref());
        } else if let Some(pw) = inline_db_pw(&secrets) {
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.clickhouse = Some(b);
        Ok(base)
    }
}

pub async fn connect_clickhouse(
    conn_id: Uuid,
    label: String,
    input: ClickhouseConnectInput,
    password: String,
) -> Result<ClickhouseConn, String> {
    validate_input(&input)?;
    let client = build_client(&input, &password);
    ping_client(&client, input.connect_timeout_ms).await?;

    let host = input.host.trim().to_string();
    let port = if input.port == 0 { 8123 } else { input.port };

    Ok(ClickhouseConn {
        id: conn_id,
        label,
        host,
        port,
        database: input.database.trim().to_string(),
        user: input.user.trim().to_string(),
        password,
        ssl_mode: input.ssl_mode.clone(),
        connect_timeout_ms: input.connect_timeout_ms,
        default_statement_timeout_ms: input.statement_timeout_ms,
        client,
    })
}

pub async fn test_clickhouse_direct(
    input: ClickhouseConnectInput,
    password: String,
) -> Result<(), String> {
    validate_input(&input)?;
    let client = build_client(&input, &password);
    ping_client(&client, input.connect_timeout_ms).await
}

async fn ping_client(client: &Client, connect_timeout_ms: Option<u64>) -> Result<(), String> {
    let timeout_ms = connect_timeout_ms.unwrap_or(15_000).clamp(500, 60_000);
    let timeout = Duration::from_millis(timeout_ms);

    let fut = client.query("SELECT 1 AS result").fetch_one::<PingRow>();
    tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| format!("CLICKHOUSE_CONNECT_TIMEOUT after {timeout_ms}ms"))?
        .map_err(|e| format!("CLICKHOUSE_PING_FAILED: {e}"))?;
    Ok(())
}

fn validate_input(input: &ClickhouseConnectInput) -> Result<(), String> {
    if input.host.trim().is_empty() {
        return Err("CLICKHOUSE_HOST_REQUIRED".into());
    }
    if input.user.trim().is_empty() {
        return Err("CLICKHOUSE_USER_REQUIRED".into());
    }
    Ok(())
}
