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

    #[serde(default)]
    pub tags: Vec<String>,

    /// UI accent / indicator color (hex, e.g. "#22c55e")
    #[serde(default)]
    pub indicator_color: Option<String>,

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

#[derive(Clone, Debug, serde::Deserialize)]
pub struct ConnectionTestSecrets {
    pub db_password: Option<String>,
    pub ssh_password: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct ConnectionTestInput {
    pub input: ConnectionCreateInput,
    pub secrets: Option<ConnectionTestSecrets>,
}
