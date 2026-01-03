use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ssh_tunnel::types::SshTunnelInput,
    types::{
        engine::{EngineKind, MySqlConnectInput, PgConnectInput},
        RedisConnectInput,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionCreateInput {
    pub engine: EngineKind,
    pub label: String,

    pub postgres: Option<PgConnectInput>,
    pub mysql: Option<MySqlConnectInput>,
    pub redis: Option<RedisConnectInput>,

    pub ssh: Option<SshTunnelInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub id: Uuid,
    pub engine: EngineKind,
    pub label: String,
}
