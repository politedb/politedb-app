use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::{ConnectionCreateInput, EngineKind};
use crate::types::{ConnectionInfo as AppConnectionInfo, ConnectionTestSecrets};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub engine: EngineKind,
    pub label: String,

    /// Raw connection input (password may be SecretRef)
    pub input: ConnectionCreateInput,

    /// UI metadata (persisted)
    #[serde(default)]
    pub tags: Vec<String>,

    /// UI accent / indicator color (hex, e.g. "#22c55e")
    #[serde(default)]
    pub indicator_color: Option<String>,

    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileConnectInput {
    pub profile_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileConnectResult {
    pub profile: ConnectionProfile,
    pub connection: AppConnectionInfo,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct ProfileConnectTestInput {
    pub profile_id: String,
    pub input: ConnectionCreateInput,           // override from form
    pub secrets: Option<ConnectionTestSecrets>, // optional plain pw for test
}
