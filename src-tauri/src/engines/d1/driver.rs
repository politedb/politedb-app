use async_trait::async_trait;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::d1::api::{default_api_base, execute_d1_query};
use crate::engines::d1::connection::D1Conn;
use crate::engines::driver::EngineDriver;
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::EngineConnection;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, D1ConnectInput, EngineKind, SecretRef,
};

pub struct D1Driver;

#[async_trait]
impl EngineDriver for D1Driver {
    fn kind(&self) -> EngineKind {
        EngineKind::D1
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let d1 = input.d1.ok_or("D1_CONFIG_MISSING")?;
        let conn = connect_d1(app, conn_id, label, d1).await?;
        Ok(EngineConnection::D1(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let d1 = input.d1.ok_or("D1_CONFIG_MISSING")?;
        test_d1(app, d1, secrets).await
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        let mut b = base.d1.ok_or("D1_CONFIG_MISSING")?;

        if let Some(ov_d1) = ov.d1 {
            if !ov_d1.account_id.trim().is_empty() {
                b.account_id = ov_d1.account_id;
            }
            if !ov_d1.database_id.trim().is_empty() {
                b.database_id = ov_d1.database_id;
            }
            if ov_d1.api_base_url.is_some() {
                b.api_base_url = ov_d1.api_base_url;
            }
            if ov_d1.statement_timeout_ms.is_some() {
                b.statement_timeout_ms = ov_d1.statement_timeout_ms;
            }
            merge_secret_for_test(&mut b.api_token, &ov_d1.api_token, &secrets);
        }

        base.d1 = Some(b);
        Ok(base)
    }
}

fn merge_secret_for_test(
    base: &mut SecretRef,
    ov: &SecretRef,
    secrets: &Option<ConnectionTestSecrets>,
) {
    if let Some(pw) = secrets
        .as_ref()
        .and_then(|s| s.db_password.as_ref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        base.kind = crate::types::SecretRefKind::Inline;
        base.value = pw.to_string();
        return;
    }

    if ov.kind == crate::types::SecretRefKind::Inline && !ov.value.trim().is_empty() {
        *base = ov.clone();
    }
}

pub async fn connect_d1(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: D1ConnectInput,
) -> Result<D1Conn, String> {
    let account_id = input.account_id.trim().to_string();
    let database_id = input.database_id.trim().to_string();
    if account_id.is_empty() {
        return Err("D1_ACCOUNT_ID_REQUIRED".into());
    }
    if database_id.is_empty() {
        return Err("D1_DATABASE_ID_REQUIRED".into());
    }

    let api_token = resolve_secret_ref(app, &input.api_token).await?;
    let api_base = default_api_base(input.api_base_url.as_deref());

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("D1_HTTP_CLIENT_FAILED: {e}"))?;

    execute_d1_query(
        &http,
        &api_base,
        &account_id,
        &database_id,
        &api_token,
        "SELECT 1",
    )
    .await
    .map_err(|e| format!("D1_CONNECT_FAILED: {e}"))?;

    Ok(D1Conn {
        id: conn_id,
        label,
        account_id,
        database_id,
        api_token,
        api_base,
        default_statement_timeout_ms: input.statement_timeout_ms,
        http: std::sync::Arc::new(http),
    })
}

pub async fn test_d1(
    app: &AppHandle,
    input: D1ConnectInput,
    secrets: Option<ConnectionTestSecrets>,
) -> Result<(), String> {
    let account_id = input.account_id.trim().to_string();
    let database_id = input.database_id.trim().to_string();
    if account_id.is_empty() {
        return Err("D1_ACCOUNT_ID_REQUIRED".into());
    }
    if database_id.is_empty() {
        return Err("D1_DATABASE_ID_REQUIRED".into());
    }

    let api_token = resolve_secret_ref_for_test(
        app,
        &input.api_token,
        secrets.as_ref().and_then(|s| s.db_password.as_deref()),
    )
    .await?;

    let api_base = default_api_base(input.api_base_url.as_deref());
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("D1_HTTP_CLIENT_FAILED: {e}"))?;

    execute_d1_query(
        &http,
        &api_base,
        &account_id,
        &database_id,
        &api_token,
        "SELECT 1",
    )
    .await
    .map_err(|e| format!("D1_TEST_FAILED: {e}"))?;

    Ok(())
}
