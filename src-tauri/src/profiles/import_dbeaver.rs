use serde_json::Value;

use crate::profiles::import_common::{
    default_port, empty_secret, inline_secret, new_profile, parse_jdbc_url, parse_port,
    tag_from_env,
};
use crate::profiles::types::ConnectionProfile;
use crate::ssh_tunnel::types::{SshAuth, SshTunnelInput};
use crate::types::{
    CassandraConnectInput, ConnectionCreateInput, DuckdbConnectInput, EngineKind,
    MongoConnectInput, MySqlConnectInput, OracleConnectInput, PgConnectInput, RedisConnectInput,
    SnowflakeConnectInput, SqlServerConnectInput, SqliteConnectInput,
};

#[derive(Debug, Default)]
pub struct DBeaverImportReport {
    pub profiles: Vec<ConnectionProfile>,
    pub skipped: Vec<String>,
}

pub fn parse_dbeaver_json(json: &str) -> Result<DBeaverImportReport, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("DBEAVER_JSON_INVALID: {e}"))?;

    let connections = if let Some(map) = root.get("connections").and_then(|v| v.as_object()) {
        map.clone()
    } else if root.is_object() {
        root.as_object().cloned().unwrap_or_default()
    } else {
        return Err("DBEAVER_JSON_INVALID: expected a connections object".into());
    };

    let mut report = DBeaverImportReport::default();

    for (id, entry) in connections {
        match connection_to_profile(&id, entry) {
            Ok(Some(profile)) => report.profiles.push(profile),
            Ok(None) => {}
            Err(reason) => report.skipped.push(reason),
        }
    }

    if report.profiles.is_empty() && report.skipped.is_empty() {
        return Err("DBEAVER_IMPORT_EMPTY: no connections found".into());
    }

    Ok(report)
}

fn connection_to_profile(id: &str, entry: Value) -> Result<Option<ConnectionProfile>, String> {
    let name = entry
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(id)
        .trim()
        .to_string();

    if name.is_empty() {
        return Err(format!("Skipped unnamed connection ({id})"));
    }

    let provider = entry
        .get("provider")
        .or_else(|| entry.get("driver"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let engine = map_dbeaver_engine(&provider)
        .ok_or_else(|| format!("Skipped \"{name}\": unsupported driver ({provider})"))?;

    let config = entry.get("configuration").cloned().unwrap_or(Value::Null);
    let mut input = build_input(engine, &name, &config)?;
    input.tags = config
        .get("type")
        .and_then(|v| v.as_str())
        .map(tag_from_env)
        .unwrap_or_default();

    if let Some(ssh) = parse_dbeaver_ssh(&config, &input) {
        input.ssh = Some(ssh);
    }

    Ok(Some(new_profile(input)))
}

fn map_dbeaver_engine(provider: &str) -> Option<EngineKind> {
    let p = provider.to_ascii_lowercase();
    if p.contains("postgres") {
        return Some(EngineKind::Postgres);
    }
    if p.contains("mariadb") {
        return Some(EngineKind::Mariadb);
    }
    if p.contains("mysql") {
        return Some(EngineKind::Mysql);
    }
    if p.contains("sqlserver") || p.contains("mssql") {
        return Some(EngineKind::Sqlserver);
    }
    if p.contains("sqlite") {
        return Some(EngineKind::Sqlite);
    }
    if p.contains("oracle") {
        return Some(EngineKind::Oracle);
    }
    if p.contains("mongo") {
        return Some(EngineKind::Mongo);
    }
    if p.contains("cassandra") {
        return Some(EngineKind::Cassandra);
    }
    if p.contains("redis") {
        return Some(EngineKind::Redis);
    }
    if p.contains("snowflake") {
        return Some(EngineKind::Snowflake);
    }
    if p.contains("duckdb") {
        return Some(EngineKind::Duckdb);
    }
    if p.contains("clickhouse") {
        return Some(EngineKind::Clickhouse);
    }
    None
}

fn config_str(config: &Value, key: &str) -> Option<String> {
    config.get(key).and_then(|v| match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn build_input(
    engine: EngineKind,
    label: &str,
    config: &Value,
) -> Result<ConnectionCreateInput, String> {
    let url = config_str(config, "url");
    let mut host = config_str(config, "host").unwrap_or_else(|| "localhost".to_string());
    let mut port = parse_port(config_str(config, "port").as_deref(), default_port(engine));
    let mut database = config_str(config, "database").unwrap_or_default();

    if let Some(ref jdbc) = url {
        if let Some((h, p, db)) = parse_jdbc_url(jdbc) {
            if !h.is_empty() {
                host = h;
            }
            if p > 0 {
                port = p;
            }
            if !db.is_empty() {
                database = db;
            }
        }
    }

    let user = config_str(config, "user").unwrap_or_default();
    let password = config_str(config, "password")
        .map(inline_secret)
        .unwrap_or_else(empty_secret);

    let mut input = ConnectionCreateInput {
        engine,
        label: label.to_string(),
        tags: Vec::new(),
        indicator_color: None,
        postgres: None,
        mysql: None,
        sqlserver: None,
        sqlite: None,
        d1: None,
        turso: None,
        oracle: None,
        mongo: None,
        cassandra: None,
        redis: None,
        snowflake: None,
        duckdb: None,
        clickhouse: None,
        ssh: None,
    };

    match engine {
        EngineKind::Postgres => {
            input.postgres = Some(PgConnectInput {
                host,
                port,
                database,
                user,
                password,
                ssl_mode: None,
                ssl_key_path: None,
                ssl_cert_path: None,
                ssl_ca_path: None,
                pool_max_size: None,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Mysql | EngineKind::Mariadb => {
            input.mysql = Some(MySqlConnectInput {
                host,
                port,
                database,
                user,
                password,
                ssl_mode: None,
                ssl_key_path: None,
                ssl_cert_path: None,
                ssl_ca_path: None,
                pool_max_size: None,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Sqlserver => {
            input.sqlserver = Some(SqlServerConnectInput {
                host,
                port,
                database,
                user,
                password,
                encrypt: None,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Sqlite => {
            let path = if !database.is_empty() {
                database
            } else {
                url.unwrap_or_else(|| ":memory:".to_string())
            };
            input.sqlite = Some(SqliteConnectInput {
                path,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Oracle => {
            input.oracle = Some(OracleConnectInput {
                host,
                port,
                database,
                user,
                password,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Mongo => {
            input.mongo = Some(MongoConnectInput {
                host,
                port,
                database: if database.is_empty() {
                    None
                } else {
                    Some(database)
                },
                user: if user.is_empty() { None } else { Some(user) },
                password,
                ssl_mode: None,
                connect_timeout_ms: None,
            });
        }
        EngineKind::Cassandra => {
            input.cassandra = Some(CassandraConnectInput {
                host,
                port,
                keyspace: if database.is_empty() {
                    None
                } else {
                    Some(database)
                },
                user: if user.is_empty() { None } else { Some(user) },
                password,
                ssl_mode: None,
                connect_timeout_ms: None,
            });
        }
        EngineKind::Redis => {
            input.redis = Some(RedisConnectInput {
                host,
                port,
                user: if user.is_empty() { None } else { Some(user) },
                password,
                db: None,
                ssl_mode: None,
                connect_timeout_ms: None,
                pool_max_size: None,
            });
        }
        EngineKind::D1 => {
            return Err("Cloudflare D1 is not supported for DBeaver import".into());
        }
        EngineKind::Turso => {
            return Err("Turso is not supported for DBeaver import".into());
        }
        EngineKind::Duckdb => {
            let path = if !database.is_empty() {
                database
            } else {
                url.unwrap_or_else(|| ":memory:".to_string())
            };
            input.duckdb = Some(DuckdbConnectInput {
                path,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Snowflake => {
            let account = config_str(config, "account")
                .or_else(|| {
                    if !host.is_empty() && host != "localhost" {
                        Some(host.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            input.snowflake = Some(SnowflakeConnectInput {
                account,
                warehouse: config_str(config, "warehouse").unwrap_or_default(),
                database,
                schema: config_str(config, "schema"),
                role: config_str(config, "role"),
                user,
                password,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Clickhouse => {
            input.clickhouse = Some(crate::types::ClickhouseConnectInput {
                host,
                port,
                database,
                user,
                password,
                protocol: match port {
                    8123 | 8443 => Some(crate::types::ClickhouseProtocol::Http),
                    9000 | 9440 => Some(crate::types::ClickhouseProtocol::Native),
                    _ => None,
                },
                ssl_mode: None,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
    }

    Ok(input)
}

fn parse_dbeaver_ssh(config: &Value, input: &ConnectionCreateInput) -> Option<SshTunnelInput> {
    let handler = config
        .get("handlers")
        .and_then(|h| h.get("config"))
        .or_else(|| config.get("handler"))
        .or_else(|| config.get("ssh_tunnel"))?;

    let enabled = handler
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !enabled {
        return None;
    }

    let ssh_host = config_str(handler, "host")
        .or_else(|| config_str(handler, "jumpHost"))
        .filter(|s| !s.is_empty())?;

    let ssh_port = parse_port(config_str(handler, "port").as_deref(), 22);
    let ssh_user = config_str(handler, "user").or_else(|| config_str(handler, "username"));

    let auth_type = config_str(handler, "authType")
        .unwrap_or_default()
        .to_ascii_lowercase();

    let auth = if auth_type.contains("password") {
        let password = config_str(handler, "password").unwrap_or_default();
        if password.is_empty() {
            return None;
        }
        SshAuth::Password { password }
    } else {
        let identity_file = config_str(handler, "keyPath")
            .or_else(|| config_str(handler, "privateKey"))
            .unwrap_or_default();
        if identity_file.is_empty() {
            return None;
        }
        SshAuth::PrivateKey {
            identity_file,
            passphrase: config_str(handler, "passphrase"),
        }
    };

    let (remote_host, remote_port) = remote_target(input, handler);

    Some(SshTunnelInput {
        ssh_host,
        ssh_port,
        ssh_user,
        auth,
        remote_host,
        remote_port,
        strict_host_key_checking: Some("accept-new".into()),
        connect_timeout_ms: Some(30_000),
    })
}

fn remote_target(input: &ConnectionCreateInput, handler: &Value) -> (String, u16) {
    if let Some(host) = config_str(handler, "localHost") {
        let port = parse_port(config_str(handler, "localPort").as_deref(), 0);
        if port > 0 {
            return (host, port);
        }
    }

    match input.engine {
        EngineKind::Postgres => input
            .postgres
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 5432)),
        EngineKind::Mysql | EngineKind::Mariadb => input
            .mysql
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 3306)),
        EngineKind::Sqlserver => input
            .sqlserver
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 1433)),
        EngineKind::Oracle => input
            .oracle
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 1521)),
        EngineKind::Mongo => input
            .mongo
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 27017)),
        EngineKind::Cassandra => input
            .cassandra
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 9042)),
        EngineKind::Redis => input
            .redis
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 6379)),
        EngineKind::Sqlite
        | EngineKind::D1
        | EngineKind::Turso
        | EngineKind::Duckdb
        | EngineKind::Snowflake => ("127.0.0.1".into(), 0),
        EngineKind::Clickhouse => input
            .clickhouse
            .as_ref()
            .map(|p| (p.host.clone(), p.port))
            .unwrap_or_else(|| ("127.0.0.1".into(), 9000)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_postgres_connection() {
        let json = r#"{
          "connections": {
            "pg-1": {
              "provider": "postgresql",
              "driver": "postgres-jdbc",
              "name": "dev-db",
              "configuration": {
                "host": "10.0.0.1",
                "port": "5432",
                "database": "app",
                "url": "jdbc:postgresql://10.0.0.1:5432/app",
                "user": "postgres",
                "type": "dev"
              }
            }
          }
        }"#;

        let report = parse_dbeaver_json(json).unwrap();
        assert_eq!(report.profiles.len(), 1);
        let pg = report.profiles[0].input.postgres.as_ref().unwrap();
        assert_eq!(pg.host, "10.0.0.1");
        assert_eq!(pg.database, "app");
        assert_eq!(pg.user, "postgres");
    }

    #[test]
    fn imports_cassandra_driver() {
        let json = r#"{"connections":{"x":{"provider":"cassandra","name":"x","configuration":{"host":"10.0.0.2","port":"9042","database":"ks","user":"cassandra"}}}}"#;
        let report = parse_dbeaver_json(json).unwrap();
        assert_eq!(report.profiles.len(), 1);
        let cfg = report.profiles[0].input.cassandra.as_ref().unwrap();
        assert_eq!(cfg.host, "10.0.0.2");
        assert_eq!(cfg.port, 9042);
        assert_eq!(cfg.keyspace.as_deref(), Some("ks"));
    }
}
