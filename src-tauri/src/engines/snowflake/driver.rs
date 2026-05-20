use std::time::Duration;

use async_trait::async_trait;
use snowflake_connector_rs::{
    SnowflakeAuthMethod, SnowflakeClient, SnowflakeClientConfig, SnowflakeSession,
};
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::snowflake::connection::SnowflakeConn;
use crate::engines::EngineConnection;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, SecretRef, SecretRefKind,
    SnowflakeConnectInput,
};

pub struct SnowflakeDriver;

#[async_trait]
impl EngineDriver for SnowflakeDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Snowflake
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let sf = input.snowflake.ok_or("SNOWFLAKE_CONFIG_MISSING")?;
        let password = resolve_secret_ref(app, &sf.password).await?;
        let conn = connect_snowflake(conn_id, label, sf, password)
            .await
            .map_err(|e| format!("SNOWFLAKE_CONNECT_FAILED: {e}"))?;
        Ok(EngineConnection::Snowflake(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let sf = input.snowflake.ok_or("SNOWFLAKE_CONFIG_MISSING")?;
        let override_plain = secrets.as_ref().and_then(|s| s.db_password.as_deref());
        let password = resolve_secret_ref_for_test(app, &sf.password, override_plain).await?;
        test_snowflake_direct(sf, password)
            .await
            .map_err(|e| format!("SNOWFLAKE_TEST_FAILED: {e}"))?;
        Ok(())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.snowflake.ok_or("SNOWFLAKE_CONFIG_MISSING")?;
        if let Some(ov_sf) = ov.snowflake {
            b.account = ov_sf.account;
            b.warehouse = ov_sf.warehouse;
            b.database = ov_sf.database;
            b.schema = ov_sf.schema;
            b.role = ov_sf.role;
            b.user = ov_sf.user;
            b.connect_timeout_ms = ov_sf.connect_timeout_ms;
            b.statement_timeout_ms = ov_sf.statement_timeout_ms;

            let inline = inline_db_pw(&secrets);
            merge_secret_ref_for_test(&mut b.password, &ov_sf.password, inline.as_ref());
        } else if let Some(pw) = inline_db_pw(&secrets) {
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.snowflake = Some(b);
        Ok(base)
    }
}

pub fn build_client_config(input: &SnowflakeConnectInput) -> SnowflakeClientConfig {
    let schema = input
        .schema
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "PUBLIC".to_string());

    let role = input
        .role
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    SnowflakeClientConfig {
        account: input.account.trim().to_string(),
        role,
        warehouse: Some(input.warehouse.trim().to_string()),
        database: Some(input.database.trim().to_string()),
        schema: Some(schema),
        timeout: input
            .connect_timeout_ms
            .map(|ms| Duration::from_millis(ms.clamp(100, 300_000))),
        ..Default::default()
    }
}

pub async fn create_session(
    input: &SnowflakeConnectInput,
    password: &str,
) -> Result<SnowflakeSession, String> {
    let client = SnowflakeClient::new(
        input.user.trim(),
        SnowflakeAuthMethod::Password(password.to_string()),
        build_client_config(input),
    )
    .map_err(|e| format!("SNOWFLAKE_CLIENT_FAILED: {e}"))?;

    client
        .create_session()
        .await
        .map_err(|e| format!("SNOWFLAKE_SESSION_FAILED: {e}"))
}

pub async fn connect_snowflake(
    conn_id: Uuid,
    label: String,
    input: SnowflakeConnectInput,
    password: String,
) -> Result<SnowflakeConn, String> {
    validate_input(&input)?;
    let session = create_session(&input, &password).await?;
    let _ = session
        .query("SELECT 1")
        .await
        .map_err(|e| format!("SNOWFLAKE_PING_FAILED: {e}"))?;

    let schema = input
        .schema
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "PUBLIC".to_string());

    Ok(SnowflakeConn {
        id: conn_id,
        label,
        account: input.account.trim().to_string(),
        warehouse: input.warehouse.trim().to_string(),
        database: input.database.trim().to_string(),
        schema,
        role: input
            .role
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        user: input.user.trim().to_string(),
        password,
        connect_timeout_ms: input.connect_timeout_ms,
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_snowflake_direct(
    input: SnowflakeConnectInput,
    password: String,
) -> Result<(), String> {
    validate_input(&input)?;
    let session = create_session(&input, &password).await?;
    let _ = session
        .query("SELECT 1")
        .await
        .map_err(|e| format!("SNOWFLAKE_TEST_QUERY_FAILED: {e}"))?;
    Ok(())
}

fn validate_input(input: &SnowflakeConnectInput) -> Result<(), String> {
    if input.account.trim().is_empty() {
        return Err("SNOWFLAKE_ACCOUNT_REQUIRED".into());
    }
    if input.warehouse.trim().is_empty() {
        return Err("SNOWFLAKE_WAREHOUSE_REQUIRED".into());
    }
    if input.database.trim().is_empty() {
        return Err("SNOWFLAKE_DATABASE_REQUIRED".into());
    }
    if input.user.trim().is_empty() {
        return Err("SNOWFLAKE_USER_REQUIRED".into());
    }
    Ok(())
}
