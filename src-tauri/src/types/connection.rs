use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::engine::{EngineKind, MySqlConnectInput, PgConnectInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionCreateInput {
    pub engine: EngineKind,
    pub label: String,

    pub postgres: Option<PgConnectInput>,
    pub mysql: Option<MySqlConnectInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub id: Uuid,
    pub engine: EngineKind,
    pub label: String,
}
