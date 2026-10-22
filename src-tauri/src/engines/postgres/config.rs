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
    // Every connection (runtime pools and Test connection) carries this
    // process's tag, so the Health Inspector never signals our own sessions.
    cfg.application_name(crate::engines::postgres::app_name::postgres_app_name()?);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::postgres::app_name::postgres_app_name;

    #[test]
    fn every_connection_carries_this_process_tag() {
        let input: PgConnectInput = serde_json::from_value(serde_json::json!({
            "host": "127.0.0.1",
            "port": 5432,
            "database": "",
            "user": "u",
            "password": { "kind": "inline", "value": "" },
            "ssl_mode": null,
            "ssl_key_path": null,
            "ssl_cert_path": null,
            "ssl_ca_path": null,
            "pool_max_size": null,
            "connect_timeout_ms": null,
            "statement_timeout_ms": null
        }))
        .expect("input fixture");
        // Runtime pools (connect_pg) and Test connection (test_pg_direct)
        // both build their config here.
        let cfg = build_pg_config(&input, "secret").unwrap();
        assert_eq!(
            cfg.get_application_name(),
            Some(postgres_app_name().unwrap())
        );
    }

    /// Supplementary architecture check: production code opens PostgreSQL
    /// sessions only from configs built by `build_pg_config` (runtime pools in
    /// `connect_pg`, Test connection in `test_pg_direct`). Test modules may
    /// build their own fixtures.
    #[test]
    fn production_code_opens_postgres_only_through_build_pg_config() {
        fn production_part(source: &str) -> &str {
            source.split("#[cfg(test)]").next().unwrap_or(source)
        }
        let openers = [
            "Manager::from_config",
            ".connect(NoTls",
            "tokio_postgres::connect(",
            "Config::new()",
        ];
        let allowed = [
            ("engines/postgres/config.rs", "Config::new()"),
            ("engines/postgres/driver.rs", "Manager::from_config"),
            ("engines/postgres/driver.rs", ".connect(NoTls"),
        ];
        // Whole files compiled only for tests.
        let test_only = ["ai/agent/live_smoke.rs"];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![root.clone()];
        let mut offenders = Vec::new();
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let rel = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if test_only.contains(&rel.as_str()) {
                    continue;
                }
                let source = std::fs::read_to_string(&path).unwrap();
                for opener in openers {
                    // SQL Server builds `tiberius::Config::new()`.
                    let other_engine = opener == "Config::new()" && source.contains("tiberius");
                    if production_part(&source).contains(opener)
                        && !other_engine
                        && !allowed.contains(&(rel.as_str(), opener))
                    {
                        offenders.push(format!("{rel}: {opener}"));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "unexpected PostgreSQL openers: {offenders:?}"
        );
    }
}
