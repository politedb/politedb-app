use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use duckdb::Connection;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::duckdb::connection::DuckdbConn;
use crate::engines::EngineConnection;
use crate::types::{ConnectionCreateInput, ConnectionTestSecrets, DuckdbConnectInput, EngineKind};

pub struct DuckdbDriver;

#[async_trait]
impl EngineDriver for DuckdbDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Duckdb
    }

    async fn connect(
        &self,
        _app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let duckdb = input.duckdb.ok_or("DUCKDB_CONFIG_MISSING")?;
        let conn = connect_duckdb(conn_id, label, duckdb)
            .await
            .map_err(|e| format!("DUCKDB_CONNECT_FAILED: {e}"))?;
        Ok(EngineConnection::Duckdb(conn))
    }

    async fn test(
        &self,
        _app: &AppHandle,
        input: ConnectionCreateInput,
        _secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let duckdb = input.duckdb.ok_or("DUCKDB_CONFIG_MISSING")?;
        test_duckdb_direct(duckdb)
            .await
            .map_err(|e| format!("DUCKDB_TEST_FAILED: {e}"))?;
        Ok(())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        _secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        let mut b = base.duckdb.ok_or("DUCKDB_CONFIG_MISSING")?;
        if let Some(ov_db) = ov.duckdb {
            if !ov_db.path.trim().is_empty() {
                b.path = ov_db.path;
            }
            if ov_db.statement_timeout_ms.is_some() {
                b.statement_timeout_ms = ov_db.statement_timeout_ms;
            }
        }
        base.duckdb = Some(b);
        Ok(base)
    }
}

fn open_duckdb(path: &str) -> Result<Connection, String> {
    if path.eq_ignore_ascii_case(":memory:") {
        Connection::open_in_memory().map_err(|e| format!("DUCKDB_OPEN_FAILED: {e}"))
    } else {
        Connection::open(path).map_err(|e| format!("DUCKDB_OPEN_FAILED: {e}"))
    }
}

pub async fn connect_duckdb(
    conn_id: Uuid,
    label: String,
    input: DuckdbConnectInput,
) -> Result<DuckdbConn, String> {
    let db_path = input.path.trim().to_string();
    if db_path.is_empty() {
        return Err("DUCKDB_PATH_REQUIRED".into());
    }

    let conn = tokio::task::spawn_blocking({
        let db_path = db_path.clone();
        move || -> Result<Connection, String> {
            let conn = open_duckdb(&db_path)?;
            conn.execute_batch("SELECT 1;")
                .map_err(|e| format!("DUCKDB_SMOKE_TEST_FAILED: {e}"))?;
            Ok(conn)
        }
    })
    .await
    .map_err(|e| format!("DUCKDB_CONNECT_JOIN_FAILED: {e}"))??;

    Ok(DuckdbConn {
        id: conn_id,
        label,
        db_path,
        conn: Arc::new(Mutex::new(conn)),
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_duckdb_direct(input: DuckdbConnectInput) -> Result<(), String> {
    let db_path = input.path.trim().to_string();
    if db_path.is_empty() {
        return Err("DUCKDB_PATH_REQUIRED".into());
    }

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_duckdb(&db_path)?;
        conn.execute_batch("SELECT 1;")
            .map_err(|e| format!("DUCKDB_SMOKE_TEST_FAILED: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("DUCKDB_TEST_JOIN_FAILED: {e}"))?
}
