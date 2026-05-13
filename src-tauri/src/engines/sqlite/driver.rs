use async_trait::async_trait;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::sqlite::connection::SqliteConn;
use crate::engines::EngineConnection;
use crate::types::{ConnectionCreateInput, ConnectionTestSecrets, EngineKind, SqliteConnectInput};

pub struct SqliteDriver;

#[async_trait]
impl EngineDriver for SqliteDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Sqlite
    }

    async fn connect(
        &self,
        _app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let sqlite = input.sqlite.ok_or("SQLITE_CONFIG_MISSING")?;

        let conn = connect_sqlite(conn_id, label, sqlite)
            .await
            .map_err(|e| format!("SQLITE_CONNECT_FAILED: {e}"))?;

        Ok(EngineConnection::Sqlite(conn))
    }

    async fn test(
        &self,
        _app: &AppHandle,
        input: ConnectionCreateInput,
        _secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let sqlite = input.sqlite.ok_or("SQLITE_CONFIG_MISSING")?;

        test_sqlite_direct(sqlite)
            .await
            .map_err(|e| format!("SQLITE_TEST_FAILED: {e}"))?;

        Ok(())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        _secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        let mut b = base.sqlite.ok_or("SQLITE_CONFIG_MISSING")?;

        if let Some(ov_sqlite) = ov.sqlite {
            if !ov_sqlite.path.trim().is_empty() {
                b.path = ov_sqlite.path;
            }
            if ov_sqlite.statement_timeout_ms.is_some() {
                b.statement_timeout_ms = ov_sqlite.statement_timeout_ms;
            }
        }

        base.sqlite = Some(b);
        Ok(base)
    }
}

pub async fn connect_sqlite(
    conn_id: Uuid,
    label: String,
    input: SqliteConnectInput,
) -> Result<SqliteConn, String> {
    let db_path = input.path.trim().to_string();
    if db_path.is_empty() {
        return Err("SQLITE_PATH_REQUIRED".into());
    }

    let conn = tokio::task::spawn_blocking({
        let db_path = db_path.clone();
        move || -> Result<rusqlite::Connection, String> {
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("SQLITE_OPEN_FAILED: {e}"))?;
            conn.execute_batch("SELECT 1;")
                .map_err(|e| format!("SQLITE_SMOKE_TEST_FAILED: {e}"))?;
            Ok(conn)
        }
    })
    .await
    .map_err(|e| format!("SQLITE_CONNECT_JOIN_FAILED: {e}"))??;

    Ok(SqliteConn {
        id: conn_id,
        label,
        db_path,
        conn: std::sync::Arc::new(std::sync::Mutex::new(conn)),
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_sqlite_direct(input: SqliteConnectInput) -> Result<(), String> {
    let db_path = input.path.trim().to_string();
    if db_path.is_empty() {
        return Err("SQLITE_PATH_REQUIRED".into());
    }

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn =
            rusqlite::Connection::open(&db_path).map_err(|e| format!("SQLITE_OPEN_FAILED: {e}"))?;
        conn.execute_batch("SELECT 1;")
            .map_err(|e| format!("SQLITE_SMOKE_TEST_FAILED: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("SQLITE_TEST_JOIN_FAILED: {e}"))?
}
