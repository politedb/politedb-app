use async_trait::async_trait;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::oracle::connection::OracleConn;
use crate::engines::oracle::ensure_oracle_client_initialized;
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::EngineConnection;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, OracleConnectInput, SecretRef,
    SecretRefKind,
};

pub struct OracleDriver;

fn make_connect_string(input: &OracleConnectInput) -> String {
    format!(
        "//{}:{}/{}",
        input.host.trim(),
        input.port,
        input.database.trim()
    )
}

#[async_trait]
impl EngineDriver for OracleDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Oracle
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let oc = input.oracle.ok_or("ORACLE_CONFIG_MISSING")?;
        let password = resolve_secret_ref(app, &oc.password).await?;

        let conn = connect_oracle(conn_id, label, oc, password)
            .await
            .map_err(|e| format!("ORACLE_CONNECT_FAILED: {e}"))?;

        Ok(EngineConnection::Oracle(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let oc = input.oracle.ok_or("ORACLE_CONFIG_MISSING")?;
        let override_plain = secrets.as_ref().and_then(|s| s.db_password.as_deref());
        let password = resolve_secret_ref_for_test(app, &oc.password, override_plain).await?;

        test_oracle_direct(oc, password)
            .await
            .map_err(|e| format!("ORACLE_TEST_FAILED: {e}"))?;

        Ok(())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.oracle.ok_or("ORACLE_CONFIG_MISSING")?;

        if let Some(ov_oracle) = ov.oracle {
            b.host = ov_oracle.host;
            b.port = ov_oracle.port;
            b.user = ov_oracle.user;
            b.database = ov_oracle.database;
            b.connect_timeout_ms = ov_oracle.connect_timeout_ms;
            b.statement_timeout_ms = ov_oracle.statement_timeout_ms;

            let inline = inline_db_pw(&secrets);
            merge_secret_ref_for_test(&mut b.password, &ov_oracle.password, inline.as_ref());
        } else if let Some(pw) = inline_db_pw(&secrets) {
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.oracle = Some(b);
        Ok(base)
    }
}

pub async fn connect_oracle(
    conn_id: Uuid,
    label: String,
    input: OracleConnectInput,
    password: String,
) -> Result<OracleConn, String> {
    ensure_oracle_client_initialized()?;

    if input.host.trim().is_empty() {
        return Err("ORACLE_HOST_REQUIRED".into());
    }
    if input.user.trim().is_empty() {
        return Err("ORACLE_USER_REQUIRED".into());
    }
    if input.port == 0 {
        return Err("ORACLE_PORT_INVALID".into());
    }

    let connect_string = make_connect_string(&input);
    let user = input.user.trim().to_string();

    let connect_string_for_test = connect_string.clone();
    let user_for_test = user.clone();
    let password_for_test = password.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = oracle::Connection::connect(
            &user_for_test,
            &password_for_test,
            &connect_string_for_test,
        )
        .map_err(|e| e.to_string())?;
        let _ = conn.query_row_as::<i32>("SELECT 1 FROM dual", &[]);
        Ok(())
    })
    .await
    .map_err(|e| format!("ORACLE_CONNECT_JOIN_FAILED: {e}"))??;

    Ok(OracleConn {
        id: conn_id,
        label,
        connect_string,
        user,
        password,
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_oracle_direct(input: OracleConnectInput, password: String) -> Result<(), String> {
    ensure_oracle_client_initialized()?;

    if input.host.trim().is_empty() {
        return Err("ORACLE_HOST_REQUIRED".into());
    }
    if input.user.trim().is_empty() {
        return Err("ORACLE_USER_REQUIRED".into());
    }
    if input.port == 0 {
        return Err("ORACLE_PORT_INVALID".into());
    }

    let connect_string = make_connect_string(&input);
    let user = input.user.trim().to_string();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn =
            oracle::Connection::connect(&user, &password, &connect_string).map_err(|e| e.to_string())?;
        let _ = conn.query_row_as::<i32>("SELECT 1 FROM dual", &[]);
        Ok(())
    })
    .await
    .map_err(|e| format!("ORACLE_TEST_JOIN_FAILED: {e}"))?
}
