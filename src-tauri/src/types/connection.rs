use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ssh_tunnel::types::SshTunnelInput,
    types::{
        engine::{
            CassandraConnectInput, D1ConnectInput, DuckdbConnectInput, EngineKind,
            MongoConnectInput, MySqlConnectInput, OracleConnectInput, PgConnectInput,
            SnowflakeConnectInput, SqlServerConnectInput, SqliteConnectInput,
        },
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
    pub sqlserver: Option<SqlServerConnectInput>,
    pub sqlite: Option<SqliteConnectInput>,
    pub d1: Option<D1ConnectInput>,
    pub oracle: Option<OracleConnectInput>,
    pub mongo: Option<MongoConnectInput>,
    pub cassandra: Option<CassandraConnectInput>,
    pub redis: Option<RedisConnectInput>,
    pub snowflake: Option<SnowflakeConnectInput>,
    pub duckdb: Option<DuckdbConnectInput>,

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
