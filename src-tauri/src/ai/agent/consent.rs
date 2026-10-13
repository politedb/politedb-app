//! Data-access consent for the agent (plan ai-agent R5, decision A1).
//!
//! A grant lets one provider see query results from one saved connection. It is keyed
//! by `(profile id, provider id)` and remembers what it was given for: the provider's
//! kind and endpoint, and the connection's target (host/database/user, or file path,
//! plus any SSH hop). A change to any of those voids the grant. A missing or unreadable
//! store means no consent. Only ids, fingerprints and the endpoint host are stored.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ai::provider::AiProviderConfig;
use crate::profiles::types::ConnectionProfile;

pub const DATA_ACCESS_REQUIRED: &str = "AI_DATA_ACCESS_REQUIRED";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub profile_id: Uuid,
    pub provider_id: String,
    pub provider_kind: String,
    /// Fingerprint of the provider endpoint (kind, base URL, host, path).
    pub endpoint: String,
    /// Shown in settings.
    pub endpoint_host: String,
    /// Fingerprint of the connection target.
    pub target: String,
    pub granted_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ConsentFile {
    pub version: u32,
    pub grants: Vec<Grant>,
}

/// Storage for the consent file.
pub trait ConsentFiles: Send + Sync {
    /// `Ok(None)` when there is no file; `Err` when it exists but cannot be read or
    /// parsed.
    fn read(&self) -> Result<Option<ConsentFile>, String>;
    fn save(&self, file: &ConsentFile) -> Result<(), String>;

    /// For granting checks: missing or unreadable means no consent.
    fn load(&self) -> Option<ConsentFile> {
        self.read().ok().flatten()
    }
}

/// Removes every grant matching `drop`. An unreadable file is replaced by an empty
/// one (all its grants revoked), so it can never come back to life later.
fn remove_grants(files: &dyn ConsentFiles, drop: impl Fn(&Grant) -> bool) -> Result<(), String> {
    match files.read() {
        Ok(None) => Ok(()),
        Ok(Some(mut file)) => {
            let before = file.grants.len();
            file.grants.retain(|g| !drop(g));
            if file.grants.len() == before {
                Ok(())
            } else {
                files.save(&file)
            }
        }
        Err(_) => files.save(&ConsentFile {
            version: 1,
            grants: Vec::new(),
        }),
    }
}

fn sha256_hex(value: &serde_json::Value) -> String {
    let digest = Sha256::digest(value.to_string().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// What the connection points at. Secrets are never part of it.
pub fn target_fingerprint(profile: &ConnectionProfile) -> String {
    let input = &profile.input;
    let ssh = input.ssh.as_ref().map(|ssh| {
        serde_json::json!({
            "host": ssh.ssh_host,
            "port": ssh.ssh_port,
            "user": ssh.ssh_user,
            "remoteHost": ssh.remote_host,
            "remotePort": ssh.remote_port,
        })
    });
    let target = match (&input.postgres, &input.sqlite) {
        (Some(pg), _) => serde_json::json!({
            "host": pg.host, "port": pg.port, "database": pg.database, "user": pg.user,
        }),
        (_, Some(lite)) => serde_json::json!({ "path": lite.path }),
        _ => serde_json::Value::Null,
    };
    sha256_hex(&serde_json::json!({
        "engine": profile.engine,
        "target": target,
        "ssh": ssh,
    }))
}

/// The provider endpoint fingerprint and the host to show.
pub fn endpoint_fingerprint(config: &AiProviderConfig) -> (String, String) {
    let fingerprint = sha256_hex(&serde_json::json!({
        "kind": config.kind,
        "baseUrl": config.base_url,
        "host": config.host,
        "subPath": config.sub_path,
    }));
    let host = config
        .host
        .clone()
        .or_else(|| {
            config
                .base_url
                .as_deref()
                .and_then(|url| url::Url::parse(url).ok())
                .and_then(|url| url.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| format!("{:?}", config.kind).to_lowercase());
    (fingerprint, host)
}

fn kind_name(config: &AiProviderConfig) -> String {
    serde_json::to_value(config.kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn matches(grant: &Grant, profile: &ConnectionProfile, config: &AiProviderConfig) -> bool {
    grant.profile_id == profile.id
        && grant.provider_id == config.id
        && grant.provider_kind == kind_name(config)
        && grant.endpoint == endpoint_fingerprint(config).0
        && grant.target == target_fingerprint(profile)
}

/// Which saved profile a runtime connection was opened from, and the target it
/// pointed at then. The data comes from that target, so consent must match it even if
/// the profile was edited since.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileBinding {
    pub profile_id: Uuid,
    pub target: String,
}

impl ProfileBinding {
    pub fn of(profile: &ConnectionProfile) -> Self {
        Self {
            profile_id: profile.id,
            target: target_fingerprint(profile),
        }
    }

    /// The saved profile still describes the connected target.
    pub fn matches(&self, profile: &ConnectionProfile) -> bool {
        profile.id == self.profile_id && target_fingerprint(profile) == self.target
    }
}

/// Whether `config` may currently see data from `profile`.
pub fn is_granted(
    files: &dyn ConsentFiles,
    profile: &ConnectionProfile,
    config: &AiProviderConfig,
) -> bool {
    files
        .load()
        .is_some_and(|file| file.grants.iter().any(|g| matches(g, profile, config)))
}

/// Records consent, replacing any earlier grant for the same profile and provider.
pub fn grant(
    files: &dyn ConsentFiles,
    profile: &ConnectionProfile,
    config: &AiProviderConfig,
    now: i64,
) -> Result<(), String> {
    let mut file = files.load().unwrap_or_default();
    file.version = 1;
    file.grants
        .retain(|g| !(g.profile_id == profile.id && g.provider_id == config.id));
    let (endpoint, endpoint_host) = endpoint_fingerprint(config);
    file.grants.push(Grant {
        profile_id: profile.id,
        provider_id: config.id.clone(),
        provider_kind: kind_name(config),
        endpoint,
        endpoint_host,
        target: target_fingerprint(profile),
        granted_at: now,
    });
    files.save(&file)
}

/// Removes every grant for a profile (revocation, or the profile was deleted).
pub fn revoke_profile(files: &dyn ConsentFiles, profile_id: Uuid) -> Result<(), String> {
    remove_grants(files, |g| g.profile_id == profile_id)
}

/// Removes every grant for `profile_ids` in one write, then runs `commit`. If the
/// grants cannot be removed durably, `commit` never runs: a profile replaced by
/// `commit` (an import) can never inherit a grant (plan R5).
pub fn revoke_then<T>(
    files: &dyn ConsentFiles,
    profile_ids: &[Uuid],
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    remove_grants(files, |g| profile_ids.contains(&g.profile_id))?;
    commit()
}

pub fn list(files: &dyn ConsentFiles) -> Vec<Grant> {
    files.load().map(|f| f.grants).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::AiProviderKind;
    use crate::types::{ConnectionCreateInput, EngineKind};
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryFiles(Mutex<Option<ConsentFile>>, Mutex<bool>);

    impl ConsentFiles for MemoryFiles {
        fn read(&self) -> Result<Option<ConsentFile>, String> {
            if *self.1.lock().unwrap() {
                return Err("corrupt".into());
            }
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, file: &ConsentFile) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(file.clone());
            *self.1.lock().unwrap() = false;
            Ok(())
        }
    }

    fn profile(path: &str) -> ConnectionProfile {
        let input: ConnectionCreateInput = serde_json::from_value(serde_json::json!({
            "engine": "sqlite",
            "label": "Local",
            "sqlite": { "path": path },
        }))
        .unwrap();
        ConnectionProfile {
            id: Uuid::from_u128(7),
            engine: EngineKind::Sqlite,
            label: "Local".into(),
            input,
            tags: vec![],
            indicator_color: None,
            created_at: Default::default(),
            updated_at: Default::default(),
        }
    }

    fn provider(base_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            id: "p1".into(),
            kind: AiProviderKind::Openai,
            label: "OpenAI".into(),
            base_url: Some(base_url.into()),
            host: None,
            sub_path: None,
            default_model: "m".into(),
            models: vec![],
            api_key_ref: None,
            enabled: true,
            is_default: None,
        }
    }

    #[test]
    fn a_grant_holds_only_for_the_same_target_and_endpoint() {
        let files = MemoryFiles::default();
        let (db, api) = (profile("/data/a.db"), provider("https://api.openai.com/v1"));
        assert!(!is_granted(&files, &db, &api));
        grant(&files, &db, &api, 1).unwrap();
        assert!(is_granted(&files, &db, &api));
        assert_eq!(list(&files)[0].endpoint_host, "api.openai.com");
        // The connection now points elsewhere.
        assert!(!is_granted(&files, &profile("/data/b.db"), &api));
        // The provider now sends somewhere else.
        assert!(!is_granted(
            &files,
            &db,
            &provider("https://proxy.example.com/v1")
        ));
        // Another provider id.
        let mut other = api.clone();
        other.id = "p2".into();
        assert!(!is_granted(&files, &db, &other));
        // A different provider kind at the same endpoint.
        let mut kind = api.clone();
        kind.kind = AiProviderKind::Groq;
        assert!(!is_granted(&files, &db, &kind));
    }

    #[test]
    fn a_binding_holds_only_while_the_profile_still_describes_the_connection() {
        let connected = profile("/data/prod.db");
        let binding = ProfileBinding::of(&connected);
        assert!(binding.matches(&connected));
        // The profile was edited (to a target with consent) without reconnecting.
        assert!(!binding.matches(&profile("/data/dev.db")));
    }

    #[test]
    fn revoking_and_corruption_remove_consent() {
        let files = MemoryFiles::default();
        let (db, api) = (profile("/data/a.db"), provider("https://api.openai.com/v1"));
        grant(&files, &db, &api, 1).unwrap();
        grant(&files, &db, &api, 2).unwrap();
        assert_eq!(list(&files).len(), 1, "re-granting replaces");
        revoke_profile(&files, db.id).unwrap();
        assert!(!is_granted(&files, &db, &api));
        grant(&files, &db, &api, 3).unwrap();
        *files.1.lock().unwrap() = true;
        assert!(!is_granted(&files, &db, &api));
    }

    /// Saves fail: the earlier file stays readable, as the atomic writer guarantees.
    struct ReadOnlyFiles(ConsentFile);

    impl ConsentFiles for ReadOnlyFiles {
        fn read(&self) -> Result<Option<ConsentFile>, String> {
            Ok(Some(self.0.clone()))
        }
        fn save(&self, _: &ConsentFile) -> Result<(), String> {
            Err("AI_DATA_ACCESS_WRITE_FAILED".into())
        }
    }

    #[test]
    fn an_import_never_commits_while_grants_cannot_be_removed() {
        let files = MemoryFiles::default();
        let (db, api) = (profile("/data/a.db"), provider("https://api.openai.com/v1"));
        grant(&files, &db, &api, 1).unwrap();
        let stuck = ReadOnlyFiles(files.load().unwrap());
        let mut committed = false;
        let outcome = revoke_then(&stuck, &[db.id, Uuid::from_u128(99)], || {
            committed = true;
            Ok(())
        });
        assert_eq!(outcome.unwrap_err(), "AI_DATA_ACCESS_WRITE_FAILED");
        assert!(!committed, "the import must not replace the profile");

        // Writable: all grants of the imported ids go in one write, then commit.
        let outcome = revoke_then(&files, &[db.id], || Ok("imported"));
        assert_eq!(outcome.unwrap(), "imported");
        assert!(!is_granted(&files, &db, &api));
    }

    #[test]
    fn fingerprints_hold_no_secrets() {
        let mut db = profile("/data/a.db");
        db.input.ssh = Some(crate::ssh_tunnel::types::SshTunnelInput {
            ssh_host: "bastion".into(),
            ssh_port: 22,
            ssh_user: Some("u".into()),
            auth: crate::ssh_tunnel::types::SshAuth::Password {
                password: "SECRET".into(),
            },
            remote_host: "db".into(),
            remote_port: 5432,
            strict_host_key_checking: None,
            connect_timeout_ms: None,
        });
        let fingerprint = target_fingerprint(&db);
        assert_eq!(fingerprint.len(), 64);
        assert_ne!(fingerprint, target_fingerprint(&profile("/data/a.db")));
    }

    /// Unreadable now, readable again later (permissions restored): a revocation in
    /// between must still hold.
    struct Flaky {
        inner: MemoryFiles,
        unreadable: Mutex<bool>,
        writable: bool,
    }

    impl ConsentFiles for Flaky {
        fn read(&self) -> Result<Option<ConsentFile>, String> {
            if *self.unreadable.lock().unwrap() {
                return Err("unreadable".into());
            }
            self.inner.read()
        }
        fn save(&self, file: &ConsentFile) -> Result<(), String> {
            if !self.writable {
                return Err("AI_DATA_ACCESS_WRITE_FAILED".into());
            }
            self.inner.save(file)
        }
    }

    #[test]
    fn an_unreadable_file_cannot_hide_a_grant_from_revocation() {
        let (db, api) = (profile("/data/a.db"), provider("https://api.openai.com/v1"));
        for writable in [true, false] {
            let files = Flaky {
                inner: MemoryFiles::default(),
                unreadable: Mutex::new(false),
                writable: true,
            };
            grant(&files, &db, &api, 1).unwrap();
            let files = Flaky { writable, ..files };
            *files.unreadable.lock().unwrap() = true;
            let mut committed = false;
            let outcome = revoke_then(&files, &[db.id], || {
                committed = true;
                Ok(())
            });
            *files.unreadable.lock().unwrap() = false;
            if writable {
                // Replaced by an empty file: the old grant is gone for good.
                assert!(outcome.is_ok() && committed);
                assert!(!is_granted(&files, &db, &api));
            } else {
                // Could not revoke: nothing imported.
                assert!(outcome.is_err() && !committed);
            }
        }
    }
}
