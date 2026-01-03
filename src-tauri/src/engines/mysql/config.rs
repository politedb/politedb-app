use anyhow::anyhow;
use mysql_async::{Opts, OptsBuilder, SslOpts};

use crate::types::MySqlConnectInput;

pub struct MysqlOptsPlan {
    pub primary: Opts,
    pub fallback: Option<Opts>,
}

pub fn build_mysql_opts(
    input: &MySqlConnectInput,
    password: &str,
) -> anyhow::Result<MysqlOptsPlan> {
    if input.host.trim().is_empty() {
        return Err(anyhow!("MYSQL_HOST_REQUIRED"));
    }
    if input.user.trim().is_empty() {
        return Err(anyhow!("MYSQL_USER_REQUIRED"));
    }
    if input.database.trim().is_empty() {
        return Err(anyhow!("MYSQL_DATABASE_REQUIRED"));
    }
    if input.port == 0 {
        return Err(anyhow!("MYSQL_PORT_INVALID"));
    }

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

        "require" | "verify-ca" | "verify-full" => {
            let ssl = SslOpts::default();
            let primary: Opts = base.ssl_opts(Some(ssl)).into();
            Ok(MysqlOptsPlan {
                primary,
                fallback: None,
            })
        }

        "prefer" => {
            // primary: try TLS
            let primary: Opts = base.clone().ssl_opts(Some(SslOpts::default())).into();
            // fallback: no TLS
            let fallback: Opts = base.ssl_opts(None).into();

            Ok(MysqlOptsPlan {
                primary,
                fallback: Some(fallback),
            })
        }

        _ => Err(anyhow!("INVALID_SSL_MODE")),
    }
}
