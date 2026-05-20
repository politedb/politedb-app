use uuid::Uuid;

use crate::profiles::types::ConnectionProfile;
use crate::types::secret::{SecretRef, SecretRefKind};
use crate::types::{ConnectionCreateInput, EngineKind};

pub fn inline_secret(value: impl Into<String>) -> SecretRef {
    SecretRef {
        kind: SecretRefKind::Inline,
        value: value.into(),
    }
}

pub fn empty_secret() -> SecretRef {
    inline_secret("")
}

pub fn now_epoch_sec() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn new_profile(input: ConnectionCreateInput) -> ConnectionProfile {
    let now = now_epoch_sec();
    ConnectionProfile {
        id: Uuid::new_v4(),
        engine: input.engine,
        label: input.label.clone(),
        input,
        tags: Vec::new(),
        indicator_color: None,
        created_at: now,
        updated_at: now,
    }
}

pub fn parse_port(raw: Option<&str>, default_port: u16) -> u16 {
    raw.and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(default_port)
}

pub fn default_port(engine: EngineKind) -> u16 {
    match engine {
        EngineKind::Postgres => 5432,
        EngineKind::Mysql | EngineKind::Mariadb => 3306,
        EngineKind::Sqlserver => 1433,
        EngineKind::Oracle => 1521,
        EngineKind::Mongo => 27017,
        EngineKind::Redis => 6379,
        EngineKind::Sqlite | EngineKind::D1 | EngineKind::Duckdb | EngineKind::Snowflake => 0,
    }
}

/// Parse `jdbc:postgresql://host:port/db` and similar URLs.
pub fn parse_jdbc_url(url: &str) -> Option<(String, u16, String)> {
    let url = url.trim();
    let without_scheme = url
        .strip_prefix("jdbc:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(_, rest)| rest)
        .unwrap_or(url);

    let without_scheme = without_scheme
        .trim_start_matches("sqlite:")
        .trim_start_matches("postgresql:")
        .trim_start_matches("postgres:")
        .trim_start_matches("mysql:")
        .trim_start_matches("mariadb:")
        .trim_start_matches("sqlserver:")
        .trim_start_matches("oracle:thin:@")
        .trim_start_matches("oracle:")
        .trim_start_matches("mongodb:")
        .trim_start_matches("redis:");

    if without_scheme.starts_with("//") {
        let rest = &without_scheme[2..];
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let database = path.trim_start_matches('/').to_string();

        let (host, port) = if authority.contains('[') {
            let end = authority.find(']')?;
            let host = authority[..=end].to_string();
            let port = authority
                .get(end + 1..)
                .and_then(|s| s.strip_prefix(':'))
                .and_then(|p| p.parse().ok())
                .unwrap_or(0);
            (host, port)
        } else if let Some((host, port)) = authority.rsplit_once(':') {
            if let Ok(port) = port.parse::<u16>() {
                (host.to_string(), port)
            } else {
                (authority.to_string(), 0)
            }
        } else {
            (authority.to_string(), 0)
        };

        return Some((host, port, database));
    }

    if !without_scheme.is_empty() && !without_scheme.contains("://") {
        return Some(("localhost".into(), 0, without_scheme.to_string()));
    }

    None
}

pub fn tag_from_env(env: &str) -> Vec<String> {
    let trimmed = env.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    vec![trimmed.to_string()]
}
