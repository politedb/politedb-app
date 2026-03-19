use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Postgres,
    Mysql,
    Mariadb,
    Mongo,
    Redis,
    // Sqlite,
}

use crate::types::secret::SecretRef;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgConnectInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,

    pub password: SecretRef,

    pub ssl_mode: Option<String>,
    pub ssl_key_path: Option<String>,
    pub ssl_cert_path: Option<String>,
    pub ssl_ca_path: Option<String>,

    pub pool_max_size: Option<usize>,
    // Optional client-side certificates (PEM-encoded)

    // Timeouts (ms)
    pub connect_timeout_ms: Option<u64>,
    pub statement_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MySqlConnectInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: crate::types::SecretRef,

    // SSL mode: "disable" | "prefer" | "require"
    pub ssl_mode: Option<String>,
    pub ssl_key_path: Option<String>,
    pub ssl_cert_path: Option<String>,
    pub ssl_ca_path: Option<String>,

    pub pool_max_size: Option<usize>,
    pub connect_timeout_ms: Option<u64>,
    pub statement_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MongoConnectInput {
    pub host: String,
    pub port: u16,
    pub database: Option<String>,
    pub user: Option<String>,
    pub password: crate::types::SecretRef,

    pub ssl_mode: Option<String>,
    pub connect_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisConnectInput {
    pub host: String,
    pub port: u16,

    pub user: Option<String>,

    pub password: SecretRef,

    // Redis database index: 0..=15
    pub db: Option<u8>,

    // "disable" | "prefer" | "require"
    pub ssl_mode: Option<String>,

    pub connect_timeout_ms: Option<u64>,
    pub pool_max_size: Option<usize>,
}
