use tauri::AppHandle;
use uuid::Uuid;

use crate::types::{ConnectionCreateInput, ConnectionTestSecrets, EngineKind};

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
