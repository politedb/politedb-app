//! Opening a saved profile on another database ("Open database"), and what a
//! runtime connection was opened on.
//!
//! The override is applied to a clone of the stored input, so its secret
//! references, SSH tunnel, TLS and other options stay as saved; the clone is
//! never saved or sent back.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::profiles::types::ConnectionProfile;
use crate::types::{ConnectionCreateInput, EngineKind};

/// What a runtime connection was opened on: recorded when it is created,
/// before the input is consumed (and before SSH rewriting), never derived
/// from display text. `profile_id` is `None` for connections not opened from
/// a saved profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeTarget {
    pub profile_id: Option<Uuid>,
    pub profile_revision: Option<String>,
    /// The database opened instead of the profile's own, if any.
    pub database_override: Option<String>,
    pub engine: EngineKind,
    /// The database / keyspace / service / SQLite path, for display only.
    pub display: String,
}

/// A blank override means none.
pub fn normalize_override(database: Option<&str>) -> Option<String> {
    database
        .map(str::trim)
        .filter(|db| !db.is_empty())
        .map(str::to_string)
}

/// `input` opened on `database` instead of its own target. Only engines
/// with Open database support accept an override.
pub fn apply_override(
    input: &ConnectionCreateInput,
    database: &str,
) -> Result<ConnectionCreateInput, String> {
    let database = database.trim();
    if database.is_empty() {
        return Err("OVERRIDE_EMPTY".into());
    }
    let mut out = input.clone();
    let missing = || "OVERRIDE_CONFIG_MISSING".to_string();
    match input.engine {
        EngineKind::Postgres => {
            out.postgres.as_mut().ok_or_else(missing)?.database = database.into()
        }
        EngineKind::Mysql | EngineKind::Mariadb => {
            out.mysql.as_mut().ok_or_else(missing)?.database = database.into()
        }
        EngineKind::Sqlserver => {
            out.sqlserver.as_mut().ok_or_else(missing)?.database = database.into()
        }
        EngineKind::Mongo => {
            out.mongo.as_mut().ok_or_else(missing)?.database = Some(database.into())
        }
        EngineKind::Sqlite => {
            if !is_plain_sqlite_path(database) {
                return Err("OVERRIDE_SQLITE_PATH_INVALID".into());
            }
            out.sqlite.as_mut().ok_or_else(missing)?.path = database.into()
        }
        EngineKind::Oracle => out.oracle.as_mut().ok_or_else(missing)?.database = database.into(),
        EngineKind::Clickhouse => {
            out.clickhouse.as_mut().ok_or_else(missing)?.database = database.into()
        }
        EngineKind::Cassandra => {
            out.cassandra.as_mut().ok_or_else(missing)?.keyspace = Some(database.into())
        }
        _ => return Err("OVERRIDE_UNSUPPORTED_ENGINE".into()),
    }
    Ok(out)
}

/// An in-memory database or a URI is not a file another tab can reopen.
fn is_plain_sqlite_path(path: &str) -> bool {
    !path.starts_with(':') && !path.to_ascii_lowercase().starts_with("file:")
}

/// What `input` (already overridden, not yet SSH-rewritten) opens.
pub fn target_identity(
    profile: Option<&ConnectionProfile>,
    database_override: Option<String>,
    input: &ConnectionCreateInput,
) -> RuntimeTarget {
    RuntimeTarget {
        profile_id: profile.map(|p| p.id),
        profile_revision: profile.map(|p| p.revision.clone()),
        database_override,
        engine: input.engine,
        display: display_target(input),
    }
}

fn display_target(input: &ConnectionCreateInput) -> String {
    let trimmed = |s: &str| s.trim().to_string();
    match input.engine {
        EngineKind::Postgres => input.postgres.as_ref().map(|c| trimmed(&c.database)),
        EngineKind::Mysql | EngineKind::Mariadb => {
            input.mysql.as_ref().map(|c| trimmed(&c.database))
        }
        // The driver connects to `master` when no database is given.
        EngineKind::Sqlserver => input.sqlserver.as_ref().map(|c| {
            let db = trimmed(&c.database);
            if db.is_empty() {
                "master".into()
            } else {
                db
            }
        }),
        EngineKind::Mongo => input
            .mongo
            .as_ref()
            .map(|c| c.database.as_deref().map(trimmed).unwrap_or_default()),
        EngineKind::Sqlite => input.sqlite.as_ref().map(|c| trimmed(&c.path)),
        EngineKind::Duckdb => input.duckdb.as_ref().map(|c| trimmed(&c.path)),
        EngineKind::Oracle => input.oracle.as_ref().map(|c| trimmed(&c.database)),
        EngineKind::Clickhouse => input.clickhouse.as_ref().map(|c| trimmed(&c.database)),
        EngineKind::Cassandra => input
            .cassandra
            .as_ref()
            .map(|c| c.keyspace.as_deref().map(trimmed).unwrap_or_default()),
        EngineKind::Snowflake => input.snowflake.as_ref().map(|c| trimmed(&c.database)),
        _ => None,
    }
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(engine: &str, config: serde_json::Value) -> ConnectionCreateInput {
        let mut v = json!({ "engine": engine, "label": "x" });
        let key = match engine {
            "mariadb" => "mysql",
            other => other,
        };
        let mut config = config;
        if engine != "sqlite" && config.get("password").is_none() {
            config["password"] = json!({ "kind": "keychain", "value": "k" });
        }
        v[key] = config;
        serde_json::from_value(v).expect("valid input")
    }

    fn pg_with_ssh(auth: serde_json::Value) -> ConnectionCreateInput {
        let mut i = input(
            "postgres",
            json!({
                "host": "db.internal", "port": 5432, "database": "app", "user": "u",
                "password": { "kind": "keychain", "value": "k_profile" },
                "ssl_mode": "require"
            }),
        );
        i.ssh = Some(
            serde_json::from_value(json!({
                "ssh_host": "bastion", "ssh_port": 22, "ssh_user": "s",
                "auth": auth,
                "remote_host": "db.internal", "remote_port": 5432,
                "strict_host_key_checking": "accept-new",
                "connect_timeout_ms": 5000
            }))
            .expect("valid SSH fixture"),
        );
        i
    }

    fn pg() -> ConnectionCreateInput {
        pg_with_ssh(json!({ "kind": "password", "password": "k_ssh" }))
    }

    #[test]
    fn sets_only_the_target_field() {
        for auth in [
            json!({ "kind": "password", "password": "k_ssh" }),
            json!({
                "kind": "private_key",
                "identity_file": "/keys/id_ed25519",
                "passphrase": "k_pass"
            }),
        ] {
            let base = pg_with_ssh(auth);
            assert!(base.ssh.is_some(), "the fixture has SSH");
            let out = apply_override(&base, " other ").unwrap();
            assert_eq!(out.postgres.as_ref().unwrap().database, "other");
            // Everything else (SSH, TLS, secret references) is untouched.
            assert_eq!(
                serde_json::to_value(&out.ssh).unwrap(),
                serde_json::to_value(&base.ssh).unwrap()
            );
            let mut back = out.clone();
            back.postgres.as_mut().unwrap().database = "app".into();
            assert_eq!(
                serde_json::to_value(&back).unwrap(),
                serde_json::to_value(&base).unwrap()
            );
        }
    }

    #[test]
    fn every_supported_engine() {
        let cases = [
            (
                "mysql",
                json!({"host":"h","port":3306,"database":"a","user":"u","password":{"kind":"keychain","value":"k"}}),
            ),
            (
                "mariadb",
                json!({"host":"h","port":3306,"database":"a","user":"u","password":{"kind":"keychain","value":"k"}}),
            ),
            (
                "sqlserver",
                json!({"host":"h","port":1433,"database":"a","user":"u","password":{"kind":"keychain","value":"k"}}),
            ),
            ("mongo", json!({"host":"h","port":27017})),
            ("sqlite", json!({"path":"/tmp/a.db"})),
            (
                "oracle",
                json!({"host":"h","port":1521,"database":"a","user":"u","password":{"kind":"keychain","value":"k"}}),
            ),
            (
                "clickhouse",
                json!({"host":"h","port":8123,"database":"a","user":"u","password":{"kind":"keychain","value":"k"}}),
            ),
            ("cassandra", json!({"host":"h","port":9042})),
        ];
        for (engine, config) in cases {
            let i = input(engine, config);
            let out = apply_override(&i, "b").unwrap_or_else(|e| panic!("{engine}: {e}"));
            assert_eq!(display_target(&out), "b", "{engine}");
        }
    }

    #[test]
    fn refuses_what_it_cannot_open() {
        assert_eq!(apply_override(&pg(), "  ").unwrap_err(), "OVERRIDE_EMPTY");
        let redis = input("redis", json!({"host":"h","port":6379}));
        assert_eq!(
            apply_override(&redis, "1").unwrap_err(),
            "OVERRIDE_UNSUPPORTED_ENGINE"
        );
        let mut no_config = pg();
        no_config.postgres = None;
        assert_eq!(
            apply_override(&no_config, "b").unwrap_err(),
            "OVERRIDE_CONFIG_MISSING"
        );
        let lite = input("sqlite", json!({"path":"/tmp/a.db"}));
        for path in [":memory:", "file:/tmp/a.db?mode=ro", "FILE:x"] {
            assert_eq!(
                apply_override(&lite, path).unwrap_err(),
                "OVERRIDE_SQLITE_PATH_INVALID"
            );
        }
    }

    #[test]
    fn blank_override_is_none() {
        assert_eq!(normalize_override(Some("  ")), None);
        assert_eq!(normalize_override(None), None);
        assert_eq!(normalize_override(Some(" b ")), Some("b".into()));
    }

    #[test]
    fn identity_records_profile_revision_and_override() {
        let profile = ConnectionProfile {
            id: Uuid::new_v4(),
            engine: EngineKind::Postgres,
            label: "p".into(),
            input: pg(),
            tags: vec![],
            indicator_color: None,
            created_at: 0,
            updated_at: 0,
            revision: "r1".into(),
        };
        let out = apply_override(&profile.input, "other").unwrap();
        let t = target_identity(Some(&profile), Some("other".into()), &out);
        assert_eq!(t.profile_id, Some(profile.id));
        assert_eq!(t.profile_revision.as_deref(), Some("r1"));
        assert_eq!(t.database_override.as_deref(), Some("other"));
        assert_eq!(t.display, "other");
        let mut ss = input(
            "sqlserver",
            json!({"host":"h","port":1433,"database":"","user":"u","password":{"kind":"keychain","value":"k"}}),
        );
        ss.label = "x".into();
        assert_eq!(target_identity(None, None, &ss).display, "master");
    }
}
