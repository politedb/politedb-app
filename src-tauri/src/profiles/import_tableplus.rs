use serde_json::Value;

use crate::profiles::import_common::{
    default_port, empty_secret, inline_secret, new_profile, parse_port, tag_from_env,
};
use crate::profiles::types::ConnectionProfile;
use crate::ssh_tunnel::types::{SshAuth, SshTunnelInput};
use crate::types::{
    ConnectionCreateInput, EngineKind, MongoConnectInput, MySqlConnectInput, OracleConnectInput,
    PgConnectInput, RedisConnectInput, SqlServerConnectInput, SqliteConnectInput,
};

#[derive(Debug, Default)]
pub struct TablePlusImportReport {
    pub profiles: Vec<ConnectionProfile>,
    pub skipped: Vec<String>,
    pub passwords_included: bool,
}

pub fn parse_tableplus_bytes(
    bytes: &[u8],
    password: Option<&str>,
) -> Result<TablePlusImportReport, String> {
    if is_rncryptor_blob(bytes) {
        let password = password
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "TABLEPLUS_PASSWORD_REQUIRED".to_string())?;
        let plain = decrypt_tableplus_export(bytes, password)?;
        return parse_tableplus_json(&plain);
    }

    if bytes.starts_with(b"bplist") {
        return parse_tableplus_plist(bytes);
    }

    let text = std::str::from_utf8(bytes)
        .map_err(|_| "TABLEPLUS_INVALID_FILE: expected UTF-8 JSON or binary plist".to_string())?;
    parse_tableplus_json(text)
}

fn is_rncryptor_blob(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x03 && bytes[1] == 0x01
}

fn decrypt_tableplus_export(bytes: &[u8], password: &str) -> Result<String, String> {
    let plain = crate::profiles::tableplus_crypt::decrypt_tableplus_export(bytes, password)?;
    String::from_utf8(plain)
        .map_err(|_| "TABLEPLUS_DECRYPT_FAILED: decrypted payload is not UTF-8".into())
}

pub fn parse_tableplus_json(json: &str) -> Result<TablePlusImportReport, String> {
    let trimmed = json.trim();
    let value: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("TABLEPLUS_JSON_INVALID: {e}"))?;

    let items = match value {
        Value::Array(items) => items,
        Value::Object(_) => vec![value],
        _ => {
            return Err("TABLEPLUS_JSON_INVALID: expected an array of connections".into());
        }
    };

    let mut report = TablePlusImportReport::default();

    for item in items {
        match connection_value_to_profile(&item) {
            Ok(Some(profile)) => {
                if profile_has_password(&profile) {
                    report.passwords_included = true;
                }
                report.profiles.push(profile);
            }
            Ok(None) => {}
            Err(reason) => report.skipped.push(reason),
        }
    }

    if report.profiles.is_empty() && report.skipped.is_empty() {
        return Err("TABLEPLUS_IMPORT_EMPTY: no connections found".into());
    }

    Ok(report)
}

fn parse_tableplus_plist(bytes: &[u8]) -> Result<TablePlusImportReport, String> {
    let value: plist::Value =
        plist::from_bytes(bytes).map_err(|e| format!("TABLEPLUS_PLIST_INVALID: {e}"))?;
    let json = plist_value_to_json(value);
    let text = serde_json::to_string(&json)
        .map_err(|e| format!("TABLEPLUS_PLIST_SERIALIZE_FAILED: {e}"))?;
    parse_tableplus_json(&text)
}

fn plist_value_to_json(value: plist::Value) -> Value {
    match value {
        plist::Value::String(s) => Value::String(s),
        plist::Value::Integer(i) => Value::String(i.to_string()),
        plist::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        plist::Value::Boolean(b) => Value::Bool(b),
        plist::Value::Array(items) => {
            Value::Array(items.into_iter().map(plist_value_to_json).collect())
        }
        plist::Value::Dictionary(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k, plist_value_to_json(v));
            }
            Value::Object(out)
        }
        plist::Value::Data(data) => Value::String(String::from_utf8_lossy(&data).into_owned()),
        _ => Value::Null,
    }
}

fn connection_value_to_profile(value: &Value) -> Result<Option<ConnectionProfile>, String> {
    let name = field_str(value, &["ConnectionName", "connectionName", "name"])
        .unwrap_or_else(|| "Unnamed".to_string());

    let driver =
        field_str(value, &["Driver", "driver", "DatabaseType", "databaseType"]).unwrap_or_default();

    let engine = map_tableplus_engine(&driver)
        .ok_or_else(|| format!("Skipped \"{name}\": unsupported driver ({driver})"))?;

    let host = field_str(value, &["DatabaseHost", "databaseHost", "host"])
        .unwrap_or_else(|| "localhost".to_string());
    let port = parse_port(
        field_str(value, &["DatabasePort", "databasePort", "port"]).as_deref(),
        default_port(engine),
    );
    let database =
        field_str(value, &["DatabaseName", "databaseName", "database"]).unwrap_or_default();
    let user = field_str(value, &["DatabaseUser", "databaseUser", "user"]).unwrap_or_default();

    let db_password = field_str(
        value,
        &[
            "ServerPassword",
            "serverPassword",
            "DatabasePassword",
            "databasePassword",
        ],
    )
    .or_else(|| field_str(value, &["Password", "password"]));

    let env = field_str(value, &["Enviroment", "Environment", "environment"]).unwrap_or_default();

    let mut input = build_tableplus_input(
        engine,
        &name,
        &host,
        port,
        &database,
        &user,
        db_password.as_deref(),
    )?;
    input.tags = tag_from_env(&env);

    if is_ssh_enabled(value) {
        if let Some(ssh) = parse_tableplus_ssh(value, &host, port) {
            input.ssh = Some(ssh);
        }
    }

    Ok(Some(new_profile(input)))
}

fn field_str(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = value.get(*key) {
            match v {
                Value::String(s) => {
                    let t = s.trim();
                    if !t.is_empty() {
                        return Some(t.to_string());
                    }
                }
                Value::Number(n) => return Some(n.to_string()),
                Value::Bool(b) => return Some(b.to_string()),
                _ => {}
            }
        }
    }
    None
}

fn field_bool(value: &Value, keys: &[&str]) -> bool {
    for key in keys {
        if let Some(v) = value.get(*key) {
            return match v {
                Value::Bool(b) => *b,
                Value::String(s) => matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "yes"),
                Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                _ => false,
            };
        }
    }
    false
}

fn is_ssh_enabled(value: &Value) -> bool {
    field_bool(value, &["isOverSSH", "is_over_ssh", "overSSH"])
}

fn map_tableplus_engine(driver: &str) -> Option<EngineKind> {
    let d = driver.to_ascii_lowercase();
    if d.contains("postgres") {
        return Some(EngineKind::Postgres);
    }
    if d.contains("mariadb") {
        return Some(EngineKind::Mariadb);
    }
    if d.contains("mysql") {
        return Some(EngineKind::Mysql);
    }
    if d.contains("sql server") || d.contains("sqlserver") || d.contains("mssql") {
        return Some(EngineKind::Sqlserver);
    }
    if d.contains("sqlite") {
        return Some(EngineKind::Sqlite);
    }
    if d.contains("oracle") {
        return Some(EngineKind::Oracle);
    }
    if d.contains("mongo") {
        return Some(EngineKind::Mongo);
    }
    if d.contains("redis") {
        return Some(EngineKind::Redis);
    }
    None
}

fn build_tableplus_input(
    engine: EngineKind,
    label: &str,
    host: &str,
    port: u16,
    database: &str,
    user: &str,
    password: Option<&str>,
) -> Result<ConnectionCreateInput, String> {
    let password = password
        .filter(|p| !p.is_empty())
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
        oracle: None,
        mongo: None,
        redis: None,
        ssh: None,
    };

    match engine {
        EngineKind::Postgres => {
            input.postgres = Some(PgConnectInput {
                host: host.to_string(),
                port,
                database: database.to_string(),
                user: user.to_string(),
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
                host: host.to_string(),
                port,
                database: database.to_string(),
                user: user.to_string(),
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
                host: host.to_string(),
                port,
                database: database.to_string(),
                user: user.to_string(),
                password,
                encrypt: None,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Sqlite => {
            let path = if database.is_empty() {
                host.to_string()
            } else {
                database.to_string()
            };
            input.sqlite = Some(SqliteConnectInput {
                path,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Oracle => {
            input.oracle = Some(OracleConnectInput {
                host: host.to_string(),
                port,
                database: database.to_string(),
                user: user.to_string(),
                password,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Mongo => {
            input.mongo = Some(MongoConnectInput {
                host: host.to_string(),
                port,
                database: if database.is_empty() {
                    None
                } else {
                    Some(database.to_string())
                },
                user: if user.is_empty() {
                    None
                } else {
                    Some(user.to_string())
                },
                password,
                ssl_mode: None,
                connect_timeout_ms: None,
            });
        }
        EngineKind::Redis => {
            input.redis = Some(RedisConnectInput {
                host: host.to_string(),
                port,
                user: if user.is_empty() {
                    None
                } else {
                    Some(user.to_string())
                },
                password,
                db: None,
                ssl_mode: None,
                connect_timeout_ms: None,
                pool_max_size: None,
            });
        }
    }

    Ok(input)
}

fn parse_tableplus_ssh(value: &Value, db_host: &str, db_port: u16) -> Option<SshTunnelInput> {
    let ssh_host = field_str(value, &["ServerAddress", "serverAddress", "sshHost"])?;
    let ssh_port = parse_port(
        field_str(value, &["ServerPort", "serverPort", "sshPort"]).as_deref(),
        22,
    );
    let ssh_user = field_str(value, &["ServerUser", "serverUser", "sshUser"]);

    let use_private_key = field_bool(value, &["isUsePrivateKey", "is_use_private_key"]);
    let auth = if use_private_key {
        let identity_file = field_str(
            value,
            &[
                "ServerPrivateKeyName",
                "serverPrivateKeyName",
                "privateKeyPath",
            ],
        )
        .filter(|p| !p.contains("Import a private key"))?;
        SshAuth::PrivateKey {
            identity_file,
            passphrase: field_str(value, &["ServerPassphrase", "serverPassphrase"]),
        }
    } else {
        let password = field_str(value, &["ServerPassword", "serverPassword", "sshPassword"])?;
        if password.is_empty() {
            return None;
        }
        SshAuth::Password { password }
    };

    Some(SshTunnelInput {
        ssh_host,
        ssh_port,
        ssh_user,
        auth,
        remote_host: db_host.to_string(),
        remote_port: db_port,
        strict_host_key_checking: Some("accept-new".into()),
        connect_timeout_ms: Some(30_000),
    })
}

fn profile_has_password(profile: &ConnectionProfile) -> bool {
    fn secret_nonempty(sr: &crate::types::SecretRef) -> bool {
        !sr.value.trim().is_empty()
    }

    let input = &profile.input;
    match input.engine {
        EngineKind::Postgres => input
            .postgres
            .as_ref()
            .is_some_and(|p| secret_nonempty(&p.password)),
        EngineKind::Mysql | EngineKind::Mariadb => input
            .mysql
            .as_ref()
            .is_some_and(|p| secret_nonempty(&p.password)),
        EngineKind::Sqlserver => input
            .sqlserver
            .as_ref()
            .is_some_and(|p| secret_nonempty(&p.password)),
        EngineKind::Oracle => input
            .oracle
            .as_ref()
            .is_some_and(|p| secret_nonempty(&p.password)),
        EngineKind::Mongo => input
            .mongo
            .as_ref()
            .is_some_and(|p| secret_nonempty(&p.password)),
        EngineKind::Redis => input
            .redis
            .as_ref()
            .is_some_and(|p| secret_nonempty(&p.password)),
        EngineKind::Sqlite => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tableplus_json_connection() {
        let json = r#"[{
          "ConnectionName": "local-pg",
          "Driver": "PostgreSQL",
          "DatabaseHost": "localhost",
          "DatabasePort": "5432",
          "DatabaseName": "app",
          "DatabaseUser": "postgres",
          "ServerPassword": "secret",
          "Enviroment": "local",
          "isOverSSH": false
        }]"#;

        let report = parse_tableplus_json(json).unwrap();
        assert_eq!(report.profiles.len(), 1);
        assert!(report.passwords_included);
        let pg = report.profiles[0].input.postgres.as_ref().unwrap();
        assert_eq!(pg.password.value, "secret");
    }

    #[test]
    fn detects_rncryptor_header() {
        assert!(is_rncryptor_blob(&[3, 1, 0]));
        assert!(!is_rncryptor_blob(b"{\"x\":1}"));
    }
}
