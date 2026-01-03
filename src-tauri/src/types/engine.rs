use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Postgres,
    Mysql,
    // Sqlite,
    // Redis,
    // Mongo,
}

use crate::types::secret::SecretRef;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgConnectInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,

    // Password có thể là inline (chỉ session) hoặc keychain ref
    pub password: SecretRef,

    // SSL mode đơn giản hoá: "disable" | "prefer" | "require"
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
