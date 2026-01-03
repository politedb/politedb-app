use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

impl ConnectionProfile {
    pub fn new_from_input(input: &crate::types::ConnectionCreateInput) -> Self {
        Self {
            id: uuid::Uuid::nil(), // sẽ được create_profile() overwrite
            engine: input.engine.clone(),
            label: input.label.clone(),
            input: input.clone(),
            created_at: 0,
            updated_at: 0,
        }
    }
}
