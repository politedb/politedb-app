use tauri::AppHandle;
use uuid::Uuid;

use crate::types::{ConnectionCreateInput, ConnectionTestSecrets, EngineKind};

/// How a runtime connection is opened; internal, never persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectPolicy {
    /// SQLite: create the file when it does not exist. False when reopening
    /// a database a tab was opened on, so a missing file is an error.
    pub sqlite_create: bool,
}

impl Default for ConnectPolicy {
    fn default() -> Self {
        Self {
            sqlite_create: true,
        }
    }
}

#[async_trait::async_trait]
pub trait EngineDriver: Send + Sync + 'static {
    fn kind(&self) -> EngineKind;

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<crate::engines::EngineConnection, String>;

    /// `connect` under a connect policy. Only engines with a policy-dependent
    /// open (SQLite: whether a missing file may be created) override it.
    async fn connect_with_policy(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
        _policy: &ConnectPolicy,
    ) -> Result<crate::engines::EngineConnection, String> {
        self.connect(app, conn_id, label, input).await
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<crate::types::ConnectionTestSecrets>,
    ) -> Result<(), String>;

    fn merge_for_test(
        &self,
        base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String>;

    /// Inline secrets → keychain refs when saving a profile (engine-specific fields).
    fn persist_profile_secrets(
        &self,
        _app: &AppHandle,
        _profile_id: Uuid,
        _persist_secrets: bool,
        input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        Ok(input)
    }

    /// Point connection config at a local SSH tunnel bind address.
    fn rewrite_tunnel_endpoint(
        &self,
        input: ConnectionCreateInput,
        host: &str,
        port: u16,
    ) -> Result<ConnectionCreateInput, String> {
        let _ = self.kind();
        crate::engines::tunnel_endpoint::rewrite_tunnel_endpoint(input, host, port)
    }
}
