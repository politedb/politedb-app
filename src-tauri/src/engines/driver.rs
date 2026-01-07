use tauri::AppHandle;
use uuid::Uuid;

use crate::types::{ConnectionCreateInput, EngineKind};

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
}
