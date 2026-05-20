use tauri::AppHandle;

use crate::profiles::types::ConnectionProfile;
use crate::security::secrets;
use crate::ssh_tunnel::types::{SshAuth, SshTunnelInput};
use crate::types::connection::ConnectionCreateInput;
use crate::types::secret::{SecretRef, SecretRefKind};
use crate::types::EngineKind;

#[derive(Debug, Clone, Copy, Default)]
pub struct SharingExportOptions {
    pub include_db_password: bool,
    pub include_ssh_password: bool,
}

/// Human-readable reminders bundled in sharing exports (recipient checklist).
pub fn sharing_checklist(options: &SharingExportOptions) -> Vec<String> {
    let mut items = Vec::new();

    if options.include_db_password {
        items.push("Database password is included inside the encrypted file (inline).".into());
    } else {
        items.push("Database password is not included — enter it after import.".into());
    }

    if options.include_ssh_password {
        items.push(
            "SSH password is included inside the encrypted file (when this connection uses password auth)."
                .into(),
        );
    } else {
        items.push(
            "SSH password is not included — enter it if the connection uses password auth.".into(),
        );
    }

    items.push(
        "SSH private key files are not included — copy the key file separately and select it in the connection editor.".into(),
    );

    if !options.include_db_password || !options.include_ssh_password {
        items.push("Machine-specific keychain references were removed from this file.".into());
    }

    items
}

pub fn prepare_profile_for_sharing_export(
    app: &AppHandle,
    profile: &mut ConnectionProfile,
    options: &SharingExportOptions,
) -> Result<(), String> {
    if options.include_db_password {
        resolve_db_passwords_inline(app, &mut profile.input)?;
    } else {
        redact_db_passwords(&mut profile.input);
    }

    if let Some(ssh) = profile.input.ssh.as_mut() {
        prepare_ssh_for_sharing_export(app, ssh, options)?;
    }

    Ok(())
}

fn prepare_ssh_for_sharing_export(
    app: &AppHandle,
    ssh: &mut SshTunnelInput,
    options: &SharingExportOptions,
) -> Result<(), String> {
    match &mut ssh.auth {
        SshAuth::Password { password } => {
            if options.include_ssh_password {
                *password = resolve_plain_secret_string(app, password)?;
            } else {
                password.clear();
            }
        }
        SshAuth::PrivateKey {
            identity_file,
            passphrase,
        } => {
            *identity_file = portable_ssh_identity_hint(identity_file);
            *passphrase = None;
        }
    }
    Ok(())
}

fn resolve_db_passwords_inline(
    app: &AppHandle,
    input: &mut ConnectionCreateInput,
) -> Result<(), String> {
    match input.engine {
        EngineKind::Postgres => {
            if let Some(pg) = input.postgres.as_mut() {
                pg.password = inline_secret_from_ref(app, &pg.password)?;
            }
        }
        EngineKind::Mysql | EngineKind::Mariadb => {
            if let Some(my) = input.mysql.as_mut() {
                my.password = inline_secret_from_ref(app, &my.password)?;
            }
        }
        EngineKind::Sqlserver => {
            if let Some(ss) = input.sqlserver.as_mut() {
                ss.password = inline_secret_from_ref(app, &ss.password)?;
            }
        }
        EngineKind::Oracle => {
            if let Some(oc) = input.oracle.as_mut() {
                oc.password = inline_secret_from_ref(app, &oc.password)?;
            }
        }
        EngineKind::Mongo => {
            if let Some(mongo) = input.mongo.as_mut() {
                mongo.password = inline_secret_from_ref(app, &mongo.password)?;
            }
        }
        EngineKind::Cassandra => {
            if let Some(cassandra) = input.cassandra.as_mut() {
                cassandra.password = inline_secret_from_ref(app, &cassandra.password)?;
            }
        }
        EngineKind::Redis => {
            if let Some(r) = input.redis.as_mut() {
                r.password = inline_secret_from_ref(app, &r.password)?;
            }
        }
        EngineKind::Snowflake => {
            if let Some(sf) = input.snowflake.as_mut() {
                sf.password = inline_secret_from_ref(app, &sf.password)?;
            }
        }
        EngineKind::Sqlite | EngineKind::D1 | EngineKind::Duckdb => {}
    }
    Ok(())
}

fn redact_db_passwords(input: &mut ConnectionCreateInput) {
    let redact = |sr: &mut SecretRef| {
        *sr = SecretRef {
            kind: SecretRefKind::Inline,
            value: String::new(),
        };
    };

    match input.engine {
        EngineKind::Postgres => {
            if let Some(pg) = input.postgres.as_mut() {
                redact(&mut pg.password);
            }
        }
        EngineKind::Mysql | EngineKind::Mariadb => {
            if let Some(my) = input.mysql.as_mut() {
                redact(&mut my.password);
            }
        }
        EngineKind::Sqlserver => {
            if let Some(ss) = input.sqlserver.as_mut() {
                redact(&mut ss.password);
            }
        }
        EngineKind::Oracle => {
            if let Some(oc) = input.oracle.as_mut() {
                redact(&mut oc.password);
            }
        }
        EngineKind::Mongo => {
            if let Some(mongo) = input.mongo.as_mut() {
                redact(&mut mongo.password);
            }
        }
        EngineKind::Cassandra => {
            if let Some(cassandra) = input.cassandra.as_mut() {
                redact(&mut cassandra.password);
            }
        }
        EngineKind::Redis => {
            if let Some(r) = input.redis.as_mut() {
                redact(&mut r.password);
            }
        }
        EngineKind::Snowflake => {
            if let Some(sf) = input.snowflake.as_mut() {
                redact(&mut sf.password);
            }
        }
        EngineKind::Sqlite | EngineKind::D1 | EngineKind::Duckdb => {}
    }
}

fn inline_secret_from_ref(app: &AppHandle, secret: &SecretRef) -> Result<SecretRef, String> {
    let value = match secret.kind {
        SecretRefKind::Keychain => resolve_keychain_secret(app, &secret.value)?,
        SecretRefKind::Inline => resolve_plain_secret_string(app, &secret.value)?,
    };

    Ok(SecretRef {
        kind: SecretRefKind::Inline,
        value,
    })
}

/// Resolve a stored password string (inline secret or keychain account name).
fn resolve_plain_secret_string(app: &AppHandle, raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    if is_keychain_reference(trimmed) {
        return resolve_keychain_secret(app, trimmed);
    }

    Ok(trimmed.to_string())
}

fn is_keychain_reference(value: &str) -> bool {
    value.starts_with("profile:") || value.starts_with("politedb/profile/")
}

fn resolve_keychain_secret(app: &AppHandle, key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("EXPORT_PASSWORD_UNAVAILABLE".into());
    }

    let value = secrets::keychain_get(app, key).map_err(|_| {
        "EXPORT_PASSWORD_UNAVAILABLE: saved secret is missing from this device's keychain"
            .to_string()
    })?;

    if value.trim().is_empty() {
        return Err("EXPORT_PASSWORD_UNAVAILABLE".into());
    }

    Ok(value)
}

/// Keep portable `~/.ssh/...` hints; replace absolute paths with a generic hint or empty.
fn portable_ssh_identity_hint(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        return trimmed.to_string();
    }

    if let Some(name) = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let lower = name.to_lowercase();
        if lower.starts_with("id_")
            || lower.ends_with(".pem")
            || lower.ends_with(".ppk")
            || lower.contains("key")
        {
            return format!("~/.ssh/{name}");
        }
    }

    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn portable_ssh_path_hint() {
        assert_eq!(
            portable_ssh_identity_hint("/Users/me/.ssh/id_ed25519"),
            "~/.ssh/id_ed25519"
        );
        assert_eq!(
            portable_ssh_identity_hint("~/custom/key.pem"),
            "~/custom/key.pem"
        );
        assert_eq!(portable_ssh_identity_hint("/tmp/random.txt"), "");
    }

    #[test]
    fn checklist_reflects_options() {
        let none = sharing_checklist(&SharingExportOptions::default());
        assert!(none
            .iter()
            .any(|s| s.contains("Database password is not included")));

        let both = sharing_checklist(&SharingExportOptions {
            include_db_password: true,
            include_ssh_password: true,
        });
        assert!(both
            .iter()
            .any(|s| s.contains("Database password is included")));
        assert!(both.iter().any(|s| s.contains("SSH password is included")));
    }

    #[test]
    fn treats_politedb_keychain_keys_as_references() {
        assert!(is_keychain_reference(
            "politedb/profile/abc/postgres/db_password"
        ));
    }

    #[test]
    fn redacts_keychain_db_password_when_not_included() {
        let mut profile = sample_profile();
        profile.input.postgres.as_mut().unwrap().password = SecretRef {
            kind: SecretRefKind::Keychain,
            value: "profile:abc:postgres:password".into(),
        };

        redact_db_passwords(&mut profile.input);

        let pw = &profile.input.postgres.as_ref().unwrap().password;
        assert_eq!(pw.kind, SecretRefKind::Inline);
        assert!(pw.value.is_empty());
    }

    fn sample_profile() -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            engine: EngineKind::Postgres,
            label: "Test".into(),
            input: ConnectionCreateInput {
                engine: EngineKind::Postgres,
                label: "Test".into(),
                tags: vec![],
                indicator_color: None,
                postgres: Some(crate::types::PgConnectInput {
                    host: "localhost".into(),
                    port: 5432,
                    database: "db".into(),
                    user: "u".into(),
                    password: SecretRef {
                        kind: SecretRefKind::Inline,
                        value: "secret".into(),
                    },
                    ssl_mode: None,
                    ssl_key_path: None,
                    ssl_cert_path: None,
                    ssl_ca_path: None,
                    pool_max_size: None,
                    connect_timeout_ms: None,
                    statement_timeout_ms: None,
                }),
                mysql: None,
                sqlserver: None,
                sqlite: None,
                d1: None,
                oracle: None,
                mongo: None,
                cassandra: None,
                redis: None,
                ssh: None,
                snowflake: None,
                duckdb: None,
            },
            tags: vec![],
            indicator_color: None,
            created_at: 0,
            updated_at: 0,
        }
    }
}
