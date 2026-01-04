use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::ConnectionInfo as AppConnectionInfo;
use crate::types::{ConnectionCreateInput, EngineKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub engine: EngineKind,
    pub label: String,

    /// Raw connection input (password may be SecretRef)
    pub input: ConnectionCreateInput,

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
