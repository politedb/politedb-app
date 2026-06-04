use std::time::Duration;

use async_trait::async_trait;
use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::sqlserver::connection::SqlServerConn;
use crate::engines::EngineConnection;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, SecretRef, SecretRefKind,
    SqlServerConnectInput,
};

pub struct SqlServerDriver;

#[async_trait]
impl EngineDriver for SqlServerDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Sqlserver
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let ss = input.sqlserver.ok_or("SQLSERVER_CONFIG_MISSING")?;
        let password = resolve_secret_ref(app, &ss.password).await?;
        let conn = connect_sqlserver(conn_id, label, ss, password)
            .await
            .map_err(|e| format!("SQLSERVER_CONNECT_FAILED: {e}"))?;
        Ok(EngineConnection::SqlServer(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let ss = input.sqlserver.ok_or("SQLSERVER_CONFIG_MISSING")?;
        let override_plain = secrets.as_ref().and_then(|s| s.db_password.as_deref());
        let password = resolve_secret_ref_for_test(app, &ss.password, override_plain).await?;
        test_sqlserver_direct(ss, password)
            .await
            .map_err(|e| format!("SQLSERVER_TEST_FAILED: {e}"))?;
        Ok(())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.sqlserver.ok_or("SQLSERVER_CONFIG_MISSING")?;
        if let Some(ov_ss) = ov.sqlserver {
            b.host = ov_ss.host;
            b.port = ov_ss.port;
            b.user = ov_ss.user;
            b.database = ov_ss.database;
            b.encrypt = ov_ss.encrypt;
            b.connect_timeout_ms = ov_ss.connect_timeout_ms;
            b.statement_timeout_ms = ov_ss.statement_timeout_ms;

            let inline = inline_db_pw(&secrets);
            merge_secret_ref_for_test(&mut b.password, &ov_ss.password, inline.as_ref());
        } else if let Some(pw) = inline_db_pw(&secrets) {
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.sqlserver = Some(b);
        Ok(base)
    }
    fn persist_profile_secrets(
        &self,
        app: &AppHandle,
        profile_id: uuid::Uuid,
        persist_secrets: bool,
        mut input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        let ss = input.sqlserver.as_mut().ok_or("SQLSERVER_CONFIG_MISSING")?;
        crate::engines::profile_secrets::persist_secret_ref(
            app,
            profile_id,
            EngineKind::Sqlserver,
            persist_secrets,
            &mut ss.password,
        )?;
        Ok(input)
    }
}

async fn make_client(
    input: &SqlServerConnectInput,
    password: &str,
) -> Result<tiberius::Client<tokio_util::compat::Compat<TcpStream>>, String> {
    let mut config = tiberius::Config::new();
    config.host(input.host.trim());
    config.port(input.port);
    let db = input.database.trim();
    config.database(if db.is_empty() { "master" } else { db });
    config.authentication(tiberius::AuthMethod::sql_server(
        input.user.trim(),
        password,
    ));
    if input.encrypt.unwrap_or(false) {
        config.encryption(tiberius::EncryptionLevel::Required);
        config.trust_cert();
    } else {
        config.encryption(tiberius::EncryptionLevel::NotSupported);
    }
    let connect_timeout = Duration::from_millis(
        input
            .connect_timeout_ms
            .unwrap_or(15_000)
            .clamp(100, 300_000),
    );

    let addr = config.get_addr();
    let tcp = tokio::time::timeout(connect_timeout, TcpStream::connect(addr))
        .await
        .map_err(|_| "SQLSERVER_TCP_CONNECT_TIMEOUT".to_string())?
        .map_err(|e| format!("SQLSERVER_TCP_CONNECT_FAILED: {e}"))?;
    tcp.set_nodelay(true)
        .map_err(|e| format!("SQLSERVER_TCP_NODELAY_FAILED: {e}"))?;
    tokio::time::timeout(
        connect_timeout,
        tiberius::Client::connect(config, tcp.compat_write()),
    )
    .await
    .map_err(|_| "SQLSERVER_CLIENT_CONNECT_TIMEOUT".to_string())?
    .map_err(|e| format!("SQLSERVER_CLIENT_CONNECT_FAILED: {e}"))
}

pub async fn connect_sqlserver(
    conn_id: Uuid,
    label: String,
    input: SqlServerConnectInput,
    password: String,
) -> Result<SqlServerConn, String> {
    validate_input(&input)?;
    let mut client = make_client(&input, &password).await?;
    let _ = client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| format!("SQLSERVER_PING_FAILED: {e}"))?;

    Ok(SqlServerConn {
        id: conn_id,
        label,
        host: input.host.trim().to_string(),
        port: input.port,
        database: {
            let db = input.database.trim();
            if db.is_empty() {
                "master".to_string()
            } else {
                db.to_string()
            }
        },
        user: input.user.trim().to_string(),
        password,
        encrypt: input.encrypt.unwrap_or(false),
        connect_timeout_ms: input.connect_timeout_ms,
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_sqlserver_direct(
    input: SqlServerConnectInput,
    password: String,
) -> Result<(), String> {
    validate_input(&input)?;
    let mut client = make_client(&input, &password).await?;
    let _ = client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| format!("SQLSERVER_TEST_QUERY_FAILED: {e}"))?;
    Ok(())
}

fn validate_input(input: &SqlServerConnectInput) -> Result<(), String> {
    if input.host.trim().is_empty() {
        return Err("SQLSERVER_HOST_REQUIRED".into());
    }
    if input.user.trim().is_empty() {
        return Err("SQLSERVER_USER_REQUIRED".into());
    }
    if input.port == 0 {
        return Err("SQLSERVER_PORT_INVALID".into());
    }
    Ok(())
}
