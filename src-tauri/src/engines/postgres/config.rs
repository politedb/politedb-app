use anyhow::anyhow;
use tokio_postgres::{config::SslMode, Config};

use crate::types::PgConnectInput;

/// Build tokio-postgres Config from PoliteDB PgConnectInput.
/// - Does NOT log or expose password
/// - SSL verify-* is mapped to Require (real verification happens in TLS layer)
pub fn build_pg_config(input: &PgConnectInput, password: &str) -> anyhow::Result<Config> {
    let mut cfg = Config::new();

    // ---------------------------------------------------------------------
    // Required fields
    // ---------------------------------------------------------------------
    cfg.host(&input.host);
    cfg.port(input.port);
    cfg.user(&input.user);
    cfg.password(password);
    let db = input.database.trim();
    cfg.dbname(if db.is_empty() { "postgres" } else { db });

    // ---------------------------------------------------------------------
    // Optional: connect timeout
    // ---------------------------------------------------------------------
    if let Some(ms) = input.connect_timeout_ms {
        if ms > 0 {
            cfg.connect_timeout(std::time::Duration::from_millis(ms));
        }
    }

    // ---------------------------------------------------------------------
    // Optional: statement timeout
    // NOTE: statement_timeout is a session GUC, set via options
    // ---------------------------------------------------------------------
    if let Some(ms) = input.statement_timeout_ms {
        if ms > 0 {
            cfg.options(format!("-c statement_timeout={}", ms));
        }
    }

    // ---------------------------------------------------------------------
    // SSL mode
    // tokio-postgres only supports Disable / Prefer / Require at config level.
    // verify-ca / verify-full are enforced via TLS connector (later).
    // ---------------------------------------------------------------------
    match input.ssl_mode.as_deref().unwrap_or("require") {
        "disable" => {
            cfg.ssl_mode(SslMode::Disable);
        }
        "prefer" => {
            cfg.ssl_mode(SslMode::Prefer);
        }
        "require" | "verify-ca" | "verify-full" => {
            cfg.ssl_mode(SslMode::Require);
        }
        _ => return Err(anyhow!("INVALID_SSL_MODE")),
    }

    Ok(cfg)
}
