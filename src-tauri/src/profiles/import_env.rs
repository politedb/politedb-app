use std::collections::BTreeMap;

use crate::profiles::import_common::{default_port, empty_secret, inline_secret, new_profile};
use crate::profiles::types::ConnectionProfile;
use crate::types::{
    ConnectionCreateInput, EngineKind, MongoConnectInput, MySqlConnectInput, PgConnectInput,
    RedisConnectInput,
};

#[derive(Debug, Default)]
pub struct EnvImportReport {
    pub profiles: Vec<ConnectionProfile>,
    pub skipped: Vec<String>,
    pub passwords_included: bool,
}

struct ParsedUrl {
    engine: EngineKind,
    host: String,
    port: u16,
    database: String,
    user: String,
    password: String,
    ssl_mode: Option<String>,
}

pub fn parse_env(text: &str) -> Result<EnvImportReport, String> {
    let mut report = EnvImportReport::default();
    let mut variables = BTreeMap::new();

    for (line_index, line) in text.lines().enumerate() {
        let Some((key, value)) = parse_assignment(line) else {
            continue;
        };
        variables.insert(key.to_ascii_uppercase(), value.clone());
        if !looks_like_database_url(&value) {
            continue;
        }

        match parse_database_url(&value) {
            Ok(parsed) => {
                report.passwords_included |= !parsed.password.is_empty();
                report
                    .profiles
                    .push(new_profile(build_input(label_from_key(&key), parsed)));
            }
            Err(reason) => report.skipped.push(format!(
                "Skipped {key} on line {}: {reason}",
                line_index + 1
            )),
        }
    }

    match parse_flat_database_config(&variables) {
        Ok(Some((label, parsed))) => {
            report.passwords_included |= !parsed.password.is_empty();
            report
                .profiles
                .push(new_profile(build_input(label, parsed)));
        }
        Ok(None) => {}
        Err(reason) if report.profiles.is_empty() => {
            return Err(format!("ENV_IMPORT_INVALID: {reason}"));
        }
        Err(reason) => report
            .skipped
            .push(format!("Skipped DB_* connection: {reason}")),
    }

    if report.profiles.is_empty() && report.skipped.is_empty() {
        return Err("ENV_IMPORT_EMPTY: no supported database URLs found".into());
    }

    Ok(report)
}

fn parse_flat_database_config(
    variables: &BTreeMap<String, String>,
) -> Result<Option<(String, ParsedUrl)>, String> {
    let host = variables.get("DB_HOST").map(|value| value.trim());
    let database = variables.get("DB_NAME").map(|value| value.trim());
    if host.is_none() && database.is_none() {
        return Ok(None);
    }

    let host = host
        .filter(|value| !value.is_empty())
        .ok_or("DB_HOST is missing")?;
    let database = database
        .filter(|value| !value.is_empty())
        .ok_or("DB_NAME is missing")?;
    let raw_engine = variables
        .get("DB_ENGINE")
        .or_else(|| variables.get("DB_CONNECTION"))
        .or_else(|| variables.get("DB_DRIVER"))
        .map(|value| value.trim());
    let raw_port = variables.get("DB_PORT").map(|value| value.trim());
    let engine = raw_engine
        .filter(|value| !value.is_empty())
        .map(parse_engine)
        .transpose()?
        .or_else(|| raw_port.and_then(infer_engine_from_port))
        .ok_or("set DB_ENGINE or use a standard DB_PORT")?;
    let port = raw_port
        .filter(|value| !value.is_empty())
        .map(parse_port)
        .transpose()?
        .unwrap_or_else(|| default_port(engine));
    let label = variables
        .get("DB_LABEL")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(database)
        .to_string();

    Ok(Some((
        label,
        ParsedUrl {
            engine,
            host: host.to_string(),
            port,
            database: database.to_string(),
            user: variables.get("DB_USER").cloned().unwrap_or_default(),
            password: variables.get("DB_PASSWORD").cloned().unwrap_or_default(),
            ssl_mode: variables
                .get("DB_SSL_MODE")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        },
    )))
}

fn parse_engine(value: &str) -> Result<EngineKind, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" | "pgsql" => Ok(EngineKind::Postgres),
        "mysql" => Ok(EngineKind::Mysql),
        "mariadb" => Ok(EngineKind::Mariadb),
        "mongo" | "mongodb" => Ok(EngineKind::Mongo),
        "redis" => Ok(EngineKind::Redis),
        other => Err(format!("unsupported DB_ENGINE {other}")),
    }
}

fn infer_engine_from_port(port: &str) -> Option<EngineKind> {
    match port.trim() {
        "5432" => Some(EngineKind::Postgres),
        "3306" => Some(EngineKind::Mysql),
        "27017" => Some(EngineKind::Mongo),
        "6379" => Some(EngineKind::Redis),
        _ => None,
    }
}

fn parse_assignment(line: &str) -> Option<(String, String)> {
    let line = line.trim().trim_start_matches('\u{feff}').trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    let line = line.strip_prefix("export ").unwrap_or(line).trim();
    let (key, raw_value) = line.split_once('=')?;
    let key = key.trim();
    if !is_env_key(key) {
        return None;
    }

    let value = parse_value(raw_value.trim());
    Some((key.to_string(), value))
}

fn is_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('A'..='Z' | 'a'..='z' | '_'))
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_value(raw: &str) -> String {
    let raw = raw
        .find(" #")
        .map(|index| raw[..index].trim_end())
        .unwrap_or(raw);

    if raw.len() >= 2 {
        let quote = raw.as_bytes()[0];
        if (quote == b'\'' || quote == b'"') && raw.as_bytes()[raw.len() - 1] == quote {
            let value = &raw[1..raw.len() - 1];
            return if quote == b'"' {
                value
                    .replace("\\n", "\n")
                    .replace("\\r", "\r")
                    .replace("\\t", "\t")
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
            } else {
                value.to_string()
            };
        }
    }

    raw.to_string()
}

fn looks_like_database_url(value: &str) -> bool {
    let scheme = value
        .split_once("://")
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    matches!(
        scheme.as_deref(),
        Some("postgres" | "postgresql" | "mysql" | "mariadb" | "mongodb" | "redis" | "rediss")
    )
}

fn parse_database_url(value: &str) -> Result<ParsedUrl, String> {
    let (scheme, rest) = value.trim().split_once("://").ok_or("invalid URL")?;
    let scheme = scheme.to_ascii_lowercase();
    let engine = match scheme.as_str() {
        "postgres" | "postgresql" => EngineKind::Postgres,
        "mysql" => EngineKind::Mysql,
        "mariadb" => EngineKind::Mariadb,
        "mongodb" => EngineKind::Mongo,
        "redis" | "rediss" => EngineKind::Redis,
        _ => return Err(format!("unsupported scheme {scheme}")),
    };

    let (authority_and_path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, path) = authority_and_path
        .split_once('/')
        .unwrap_or((authority_and_path, ""));
    let (userinfo, host_port) = authority.rsplit_once('@').unwrap_or(("", authority));
    let (user, password) = userinfo
        .split_once(':')
        .map(|(user, password)| (percent_decode(user), percent_decode(password)))
        .unwrap_or_else(|| (percent_decode(userinfo), String::new()));
    let (host, explicit_port) = parse_host_port(host_port)?;
    let port = explicit_port.unwrap_or_else(|| default_port(engine));
    let database = percent_decode(path.trim_start_matches('/'));
    let ssl_mode = query_value(query, "sslmode").or_else(|| {
        if scheme == "rediss" {
            Some("require".to_string())
        } else {
            None
        }
    });

    if host.is_empty() {
        return Err("host is missing".into());
    }

    Ok(ParsedUrl {
        engine,
        host,
        port,
        database,
        user,
        password,
        ssl_mode,
    })
}

fn parse_host_port(value: &str) -> Result<(String, Option<u16>), String> {
    if value.starts_with('[') {
        let end = value.find(']').ok_or("invalid IPv6 host")?;
        let host = value[1..end].to_string();
        let port = value[end + 1..]
            .strip_prefix(':')
            .filter(|raw| !raw.is_empty())
            .map(parse_port)
            .transpose()?;
        return Ok((host, port));
    }

    if let Some((host, raw_port)) = value.rsplit_once(':') {
        if !raw_port.is_empty() && raw_port.chars().all(|c| c.is_ascii_digit()) {
            return Ok((host.to_string(), Some(parse_port(raw_port)?)));
        }
    }
    Ok((value.to_string(), None))
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| format!("invalid port {value}"))
}

fn query_value(query: &str, target: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        key.eq_ignore_ascii_case(target)
            .then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn label_from_key(key: &str) -> String {
    let trimmed = key
        .strip_suffix("_URL")
        .or_else(|| key.strip_suffix("_URI"))
        .unwrap_or(key);
    let label = trimmed
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            let mut chars = lower.chars();
            chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ");
    if label.is_empty() {
        "Imported connection".into()
    } else {
        label
    }
}

fn empty_input(engine: EngineKind, label: String) -> ConnectionCreateInput {
    ConnectionCreateInput {
        engine,
        label,
        tags: vec!["env".into()],
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
        google_sheets: None,
        ssh: None,
    }
}

fn build_input(label: String, parsed: ParsedUrl) -> ConnectionCreateInput {
    let password = if parsed.password.is_empty() {
        empty_secret()
    } else {
        inline_secret(parsed.password)
    };
    let mut input = empty_input(parsed.engine, label);

    match parsed.engine {
        EngineKind::Postgres => {
            input.postgres = Some(PgConnectInput {
                host: parsed.host,
                port: parsed.port,
                database: parsed.database,
                user: parsed.user,
                password,
                ssl_mode: parsed.ssl_mode,
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
                host: parsed.host,
                port: parsed.port,
                database: parsed.database,
                user: parsed.user,
                password,
                ssl_mode: parsed.ssl_mode,
                ssl_key_path: None,
                ssl_cert_path: None,
                ssl_ca_path: None,
                pool_max_size: None,
                connect_timeout_ms: None,
                statement_timeout_ms: None,
            });
        }
        EngineKind::Mongo => {
            input.mongo = Some(MongoConnectInput {
                host: parsed.host,
                port: parsed.port,
                database: (!parsed.database.is_empty()).then_some(parsed.database),
                user: (!parsed.user.is_empty()).then_some(parsed.user),
                password,
                ssl_mode: parsed.ssl_mode,
                connect_timeout_ms: None,
            });
        }
        EngineKind::Redis => {
            input.redis = Some(RedisConnectInput {
                host: parsed.host,
                port: parsed.port,
                user: (!parsed.user.is_empty()).then_some(parsed.user),
                password,
                db: parsed.database.parse::<u8>().ok(),
                ssl_mode: parsed.ssl_mode,
                connect_timeout_ms: None,
                pool_max_size: None,
            });
        }
        _ => unreachable!("supported environment URL engine"),
    }

    input
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_database_urls_and_ignores_other_values() {
        let report = parse_env(
            r#"
                API_URL=https://example.com
                export DATABASE_URL="postgresql://demo%40user:p%40ss@db.local:5433/app?sslmode=require" # primary
                REDIS_URL=redis://:secret@cache.local:6380/2 # cache
            "#,
        )
        .unwrap();

        assert_eq!(report.profiles.len(), 2);
        assert!(report.passwords_included);
        let postgres = report.profiles[0].input.postgres.as_ref().unwrap();
        assert_eq!(postgres.user, "demo@user");
        assert_eq!(postgres.host, "db.local");
        assert_eq!(postgres.port, 5433);
        assert_eq!(postgres.database, "app");
        assert_eq!(postgres.ssl_mode.as_deref(), Some("require"));
        let redis = report.profiles[1].input.redis.as_ref().unwrap();
        assert_eq!(redis.db, Some(2));
    }

    #[test]
    fn reports_empty_env_file() {
        let error = parse_env("APP_URL=https://example.com\nDEBUG=true").unwrap_err();
        assert!(error.starts_with("ENV_IMPORT_EMPTY"));
    }

    #[test]
    fn parses_flat_db_variables_and_infers_postgres_from_port() {
        let report = parse_env(
            r#"
                DB_HOST=db
                DB_PORT=5432
                DB_USER=postgres
                DB_PASSWORD=postgres
                DB_NAME=zeniuz_dev
            "#,
        )
        .unwrap();

        assert_eq!(report.profiles.len(), 1);
        assert!(report.passwords_included);
        let profile = &report.profiles[0];
        assert_eq!(profile.label, "zeniuz_dev");
        assert_eq!(profile.input.tags, vec!["env"]);
        let postgres = profile.input.postgres.as_ref().unwrap();
        assert_eq!(postgres.host, "db");
        assert_eq!(postgres.port, 5432);
        assert_eq!(postgres.database, "zeniuz_dev");
        assert_eq!(postgres.user, "postgres");
        assert_eq!(postgres.password.value, "postgres");
    }
}
