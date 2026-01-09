use anyhow::anyhow;
use mysql_async::{Opts, OptsBuilder, SslOpts};

use crate::types::MySqlConnectInput;

pub struct MysqlOptsPlan {
    pub primary: Opts,
    pub fallback: Option<Opts>,
}

fn build_ssl_opts_simple(mode: &str) -> Option<SslOpts> {
    match mode {
        // No TLS
        "disable" => None,

        // TLS, no verification (DEV / internal)
        "require" => {
            let mut ssl = SslOpts::default();
            ssl = ssl.with_danger_accept_invalid_certs(true);
            ssl = ssl.with_danger_skip_domain_validation(true);
            Some(ssl)
        }

        // Prefer TLS, fallback handled outside
        "prefer" => {
            let mut ssl = SslOpts::default();
            ssl = ssl.with_danger_accept_invalid_certs(true);
            ssl = ssl.with_danger_skip_domain_validation(true);
            Some(ssl)
        }

        // These modes REQUIRE CA, but your lib can't handle CA → fail early
        "verify-ca" | "verify-full" => {
            // IMPORTANT: don't attempt TLS verify if we cannot provide CA
            // Fail fast with clear error
            panic!("MYSQL_SSL_CA_NOT_SUPPORTED_BY_DRIVER")
        }

        _ => None,
    }
}

pub fn build_mysql_opts(
    input: &MySqlConnectInput,
    password: &str,
) -> anyhow::Result<MysqlOptsPlan> {
    let base = OptsBuilder::default()
        .ip_or_hostname(input.host.clone())
        .tcp_port(input.port)
        .user(Some(input.user.clone()))
        .pass(Some(password.to_string()))
        .db_name(Some(input.database.clone()));

    let mode = input.ssl_mode.as_deref().unwrap_or("prefer");

    match mode {
        "disable" => {
            let primary: Opts = base.ssl_opts(None).into();
            Ok(MysqlOptsPlan {
                primary,
                fallback: None,
            })
        }

        "prefer" => {
            let ssl = build_ssl_opts_simple("prefer");
            let primary: Opts = base.clone().ssl_opts(ssl).into();
            let fallback: Opts = base.ssl_opts(None).into();
            Ok(MysqlOptsPlan {
                primary,
                fallback: Some(fallback),
            })
        }

        "require" => {
            let ssl = build_ssl_opts_simple("require");
            let primary: Opts = base.ssl_opts(ssl).into();
            Ok(MysqlOptsPlan {
                primary,
                fallback: None,
            })
        }

        "verify-ca" | "verify-full" => Err(anyhow!("MYSQL_SSL_VERIFY_NOT_SUPPORTED")),

        _ => Err(anyhow!("INVALID_SSL_MODE")),
    }
}
