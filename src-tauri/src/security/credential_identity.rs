//! Typed identity for PoliteDB profile credentials stored in the OS keychain.
//!
//! Logical `SecretRef` keys persisted in profiles stay unchanged
//! (`politedb/profile/<uuid>/<engine>/db_password`,
//! `politedb/profile/<uuid>/ssh_password`, `profile:<uuid>:<engine>:password`).
//! On macOS, recognized keys map to one branded physical item per
//! profile + credential purpose:
//!
//! - service (Where): [`BRANDED_SERVICE`]
//! - label (Name): [`BRANDED_LABEL`]
//! - account: `<UPPERCASE-UUID>_profile` (database credential) or
//!   `<UPPERCASE-UUID>_ssh`
//!
//! Only these two physical account spellings are supported under
//! [`BRANDED_SERVICE`] (and [`PREVIOUS_BRANDED_SERVICE`]); any other account
//! there is ignored.
//!
//! Branded items were first written under [`PREVIOUS_BRANDED_SERVICE`]
//! (the old bundle identifier). They are read, migrated and deleted there but
//! never written; see `credential_store`.
//!
//! Physical account parsing is kept separate from logical key parsing: the
//! physical suffix (`profile`) is not the logical purpose segment (`database`).
//!
//! The physical branded account spelling is never accepted as a logical key:
//! before branding, arbitrary custom keys (including ones shaped like
//! `<UUID>_profile` or `<UUID>_ssh`) were stored under [`LEGACY_SERVICE`],
//! so that spelling does not prove profile ownership. Branded items are listed under a logical
//! key in the app-owned `politedb/profile/` namespace instead:
//! `politedb/profile/<uuid>/credential/database|ssh` (see
//! [`ProfileCredential::branded_logical_key`]).
//!
//! Inventory (2026-10-05): a profile owns at most one database credential
//! (password/token for its engine) and one SSH password. The frontend and
//! backend database key formats are aliases of that same credential, so both
//! map to `_profile`; SSH maps to `_ssh`. Any other key (AI provider keys,
//! custom Keychain-screen keys) is not a profile credential and keeps its
//! legacy physical name.

use uuid::Uuid;

/// Service of branded items; shown as "Where" in Keychain Access. Differs from
/// [`LEGACY_SERVICE`] only by case: Keychain Services matches service names
/// case-sensitively (verified for the file keychain, plan
/// keychain-service-rename Phase 0).
pub const BRANDED_SERVICE: &str = "PoliteDB";
/// Service of branded items written before the rename (the old bundle
/// identifier). Read, migrated from and deleted; never written.
pub const PREVIOUS_BRANDED_SERVICE: &str = "com.politehq.politedb";
/// Explicit item label; shown as "Name" in Keychain Access.
pub const BRANDED_LABEL: &str = "PoliteDB";
/// Service used for every secret before branded entries existed.
pub const LEGACY_SERVICE: &str = "politedb";

const FRONTEND_PREFIX: &str = "politedb/profile/";
const BACKEND_PREFIX: &str = "profile:";
const BRANDED_SEGMENT: &str = "credential";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CredentialPurpose {
    Database,
    Ssh,
}

impl CredentialPurpose {
    const ALL: [CredentialPurpose; 2] = [CredentialPurpose::Database, CredentialPurpose::Ssh];

    /// Logical purpose segment in `politedb/profile/<uuid>/credential/<purpose>`.
    fn logical_suffix(self) -> &'static str {
        match self {
            CredentialPurpose::Database => "database",
            CredentialPurpose::Ssh => "ssh",
        }
    }

    fn from_logical_suffix(raw: &str) -> Option<Self> {
        match raw {
            "database" => Some(CredentialPurpose::Database),
            "ssh" => Some(CredentialPurpose::Ssh),
            _ => None,
        }
    }

    /// Physical branded account suffix.
    fn account_suffix(self) -> &'static str {
        match self {
            CredentialPurpose::Database => "profile",
            CredentialPurpose::Ssh => "ssh",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ProfileCredential {
    pub profile_id: Uuid,
    pub purpose: CredentialPurpose,
}

impl ProfileCredential {
    fn account_id(&self) -> String {
        self.profile_id
            .hyphenated()
            .to_string()
            .to_ascii_uppercase()
    }

    /// Physical account for the branded item, e.g. `0A1B…-…_profile`.
    pub fn branded_account(&self) -> String {
        format!("{}_{}", self.account_id(), self.purpose.account_suffix())
    }

    /// Logical key for the branded item, as returned by list, e.g.
    /// `politedb/profile/0a1b…/credential/database`. Lives in the app-owned
    /// profile namespace so it never aliases a pre-existing custom key.
    pub fn branded_logical_key(&self) -> String {
        format!(
            "{FRONTEND_PREFIX}{}/{BRANDED_SEGMENT}/{}",
            self.profile_id.hyphenated(),
            self.purpose.logical_suffix()
        )
    }
}

/// How a logical key was spelled; decides which legacy names are exact aliases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyForm {
    /// A pre-branding logical key; the exact legacy account equals the key.
    Legacy,
    /// The branded logical key (`politedb/profile/<uuid>/credential/<purpose>`,
    /// as returned by list); every recognized legacy alias may hold its value.
    Branded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedKey {
    pub credential: ProfileCredential,
    pub form: KeyForm,
}

/// Canonical hyphenated UUID only (8-4-4-4-12 hex). Rejects simple/braced/urn forms
/// so lookalike custom keys never alias a profile credential.
fn parse_canonical_uuid(raw: &str) -> Option<Uuid> {
    if raw.len() != 36 {
        return None;
    }
    let bytes = raw.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        let is_hyphen_pos = matches!(i, 8 | 13 | 18 | 23);
        if is_hyphen_pos {
            if *b != b'-' {
                return None;
            }
        } else if !b.is_ascii_hexdigit() {
            return None;
        }
    }
    Uuid::parse_str(raw).ok()
}

fn is_engine_segment(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Parse a pre-branding logical profile key.
pub fn parse_legacy_profile_key(key: &str) -> Option<ProfileCredential> {
    if let Some(rest) = key.strip_prefix(FRONTEND_PREFIX) {
        let parts: Vec<&str> = rest.split('/').collect();
        return match parts.as_slice() {
            [id, "ssh_password"] => Some(ProfileCredential {
                profile_id: parse_canonical_uuid(id)?,
                purpose: CredentialPurpose::Ssh,
            }),
            [id, engine, "db_password"] if is_engine_segment(engine) => Some(ProfileCredential {
                profile_id: parse_canonical_uuid(id)?,
                purpose: CredentialPurpose::Database,
            }),
            _ => None,
        };
    }

    if let Some(rest) = key.strip_prefix(BACKEND_PREFIX) {
        let parts: Vec<&str> = rest.split(':').collect();
        return match parts.as_slice() {
            [id, engine, "password"] if is_engine_segment(engine) => Some(ProfileCredential {
                profile_id: parse_canonical_uuid(id)?,
                purpose: CredentialPurpose::Database,
            }),
            _ => None,
        };
    }

    None
}

/// Parse a physical branded account found under [`BRANDED_SERVICE`] or
/// [`PREVIOUS_BRANDED_SERVICE`] (`<UPPERCASE-UUID>_profile|_ssh`). Only used for physical items, never for
/// logical keys.
pub fn parse_branded_account(account: &str) -> Option<ProfileCredential> {
    let (id, _) = account.rsplit_once('_')?;
    let profile_id = parse_canonical_uuid(id)?;
    CredentialPurpose::ALL
        .into_iter()
        .map(|purpose| ProfileCredential {
            profile_id,
            purpose,
        })
        .find(|credential| credential.branded_account() == account)
}

/// Parse a branded logical key (`politedb/profile/<uuid>/credential/<purpose>`).
/// Exact canonical (lowercase) spelling is required so list output round-trips.
pub fn parse_branded_logical_key(key: &str) -> Option<ProfileCredential> {
    let rest = key.strip_prefix(FRONTEND_PREFIX)?;
    let parts: Vec<&str> = rest.split('/').collect();
    let [id, BRANDED_SEGMENT, suffix] = parts.as_slice() else {
        return None;
    };
    let credential = ProfileCredential {
        profile_id: parse_canonical_uuid(id)?,
        purpose: CredentialPurpose::from_logical_suffix(suffix)?,
    };
    (credential.branded_logical_key() == key).then_some(credential)
}

/// Map any logical key to a profile credential, or `None` for custom keys.
/// Physical branded account spellings (`<UUID>_profile`, `<UUID>_ssh`) are
/// deliberately not mapped; they stay custom keys under the
/// legacy service.
pub fn map_key(key: &str) -> Option<MappedKey> {
    if let Some(credential) = parse_legacy_profile_key(key) {
        return Some(MappedKey {
            credential,
            form: KeyForm::Legacy,
        });
    }
    parse_branded_logical_key(key).map(|credential| MappedKey {
        credential,
        form: KeyForm::Branded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const ID_UPPER: &str = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";

    fn db(id: &str) -> ProfileCredential {
        ProfileCredential {
            profile_id: Uuid::parse_str(id).unwrap(),
            purpose: CredentialPurpose::Database,
        }
    }

    #[test]
    fn maps_frontend_database_key() {
        let key = format!("politedb/profile/{ID}/postgres/db_password");
        let mapped = map_key(&key).unwrap();
        assert_eq!(mapped.form, KeyForm::Legacy);
        assert_eq!(mapped.credential, db(ID));
        assert_eq!(
            mapped.credential.branded_account(),
            format!("{ID_UPPER}_profile")
        );
    }

    #[test]
    fn maps_backend_database_key() {
        let key = format!("profile:{ID}:google_sheets:password");
        let mapped = map_key(&key).unwrap();
        assert_eq!(mapped.credential, db(ID));
        assert_eq!(
            mapped.credential.branded_account(),
            format!("{ID_UPPER}_profile")
        );
    }

    #[test]
    fn maps_ssh_key() {
        let key = format!("politedb/profile/{ID}/ssh_password");
        let mapped = map_key(&key).unwrap();
        assert_eq!(mapped.credential.purpose, CredentialPurpose::Ssh);
        assert_eq!(
            mapped.credential.branded_account(),
            format!("{ID_UPPER}_ssh")
        );
    }

    #[test]
    fn database_and_ssh_for_same_profile_do_not_collide() {
        let db_key = format!("politedb/profile/{ID}/mysql/db_password");
        let ssh_key = format!("politedb/profile/{ID}/ssh_password");
        let a = map_key(&db_key).unwrap().credential.branded_account();
        let b = map_key(&ssh_key).unwrap().credential.branded_account();
        assert_ne!(a, b);
    }

    #[test]
    fn database_aliases_share_one_credential() {
        let fe = format!("politedb/profile/{ID}/mysql/db_password");
        let be = format!("profile:{ID}:mysql:password");
        assert_eq!(
            map_key(&fe).unwrap().credential,
            map_key(&be).unwrap().credential
        );
    }

    #[test]
    fn different_profiles_do_not_collide() {
        let other = "11111111-2222-4333-8444-555555555555";
        let a = map_key(&format!("profile:{ID}:mysql:password")).unwrap();
        let b = map_key(&format!("profile:{other}:mysql:password")).unwrap();
        assert_ne!(
            a.credential.branded_account(),
            b.credential.branded_account()
        );
    }

    #[test]
    fn branded_logical_key_round_trips() {
        let key = format!("politedb/profile/{ID}/credential/database");
        let mapped = map_key(&key).unwrap();
        assert_eq!(mapped.form, KeyForm::Branded);
        assert_eq!(mapped.credential, db(ID));
        assert_eq!(mapped.credential.branded_logical_key(), key);
        assert_eq!(
            mapped.credential.branded_account(),
            format!("{ID_UPPER}_profile")
        );
        let ssh = format!("politedb/profile/{ID}/credential/ssh");
        let mapped = map_key(&ssh).unwrap();
        assert_eq!(mapped.credential.purpose, CredentialPurpose::Ssh);
        assert_eq!(mapped.credential.branded_logical_key(), ssh);
    }

    #[test]
    fn physical_branded_account_is_not_a_logical_profile_key() {
        // Pre-branding custom keys may be spelled like a branded account.
        for key in [format!("{ID_UPPER}_profile"), format!("{ID_UPPER}_ssh")] {
            assert!(map_key(&key).is_none(), "{key} should stay a custom key");
            assert!(parse_branded_account(&key).is_some());
        }
    }

    #[test]
    fn profile_account_parses_to_database_credential() {
        let credential = parse_branded_account(&format!("{ID_UPPER}_profile")).unwrap();
        assert_eq!(credential, db(ID));
        assert_eq!(
            credential.branded_logical_key(),
            format!("politedb/profile/{ID}/credential/database")
        );
    }

    #[test]
    fn ssh_account_parses_to_ssh_credential() {
        let ssh = parse_branded_account(&format!("{ID_UPPER}_ssh")).unwrap();
        assert_eq!(ssh.purpose, CredentialPurpose::Ssh);
        assert_eq!(ssh.branded_account(), format!("{ID_UPPER}_ssh"));
    }

    #[test]
    fn database_suffix_is_not_a_branded_account() {
        let key = format!("{ID_UPPER}_database");
        assert!(parse_branded_account(&key).is_none());
        assert!(map_key(&key).is_none());
    }

    #[test]
    fn branded_logical_key_requires_canonical_spelling() {
        for key in [
            format!("politedb/profile/{ID_UPPER}/credential/database"),
            format!("politedb/profile/{ID}/credential/token"),
            // The physical suffix is not a logical purpose.
            format!("politedb/profile/{ID}/credential/profile"),
            format!("politedb/profile/{ID}/credential/database/extra"),
            format!("politedb/profile/{ID}/Credential/database"),
            "politedb/profile/not-a-uuid/credential/ssh".to_string(),
        ] {
            assert!(map_key(&key).is_none(), "{key} should not map");
        }
    }

    #[test]
    fn rejects_invalid_uuids() {
        for key in [
            "politedb/profile/not-a-uuid/postgres/db_password",
            "politedb/profile/0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d/postgres/db_password",
            "politedb/profile/{0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d}/ssh_password",
            "profile:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4z:mysql:password",
            "profile::mysql:password",
            "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d_database",
        ] {
            assert!(map_key(key).is_none(), "{key} should not map");
        }
    }

    #[test]
    fn rejects_lowercase_branded_account_to_keep_round_trip_exact() {
        for suffix in ["profile", "database", "ssh"] {
            assert!(parse_branded_account(&format!("{ID}_{suffix}")).is_none());
            assert!(map_key(&format!("{ID}_{suffix}")).is_none());
        }
    }

    #[test]
    fn rejects_unknown_purposes_and_shapes() {
        for key in [
            format!("politedb/profile/{ID}/postgres/api_key"),
            format!("politedb/profile/{ID}/ssh_passphrase"),
            format!("politedb/profile/{ID}//db_password"),
            format!("politedb/profile/{ID}/Postgres/db_password"),
            format!("politedb/profile/{ID}/postgres/db_password/extra"),
            format!("profile:{ID}:mysql:token"),
            format!("profile:{ID}:mysql:password:extra"),
            format!("{ID_UPPER}_token"),
            format!("{ID_UPPER}_database_extra"),
            format!("{ID_UPPER}_profile_extra"),
            format!("{ID_UPPER}_ssh_profile"),
            format!("politedb/profile/{ID}/token"),
            format!("politedb/profile/{ID}/database/extra"),
            format!("politedb/profile/not-a-uuid/database"),
        ] {
            assert!(map_key(&key).is_none(), "{key} should not map");
        }
    }

    #[test]
    fn custom_and_ai_keys_stay_unmapped() {
        for key in ["politedb:ai:openai:api_key", "my-custom-key", "profile", ""] {
            assert!(map_key(key).is_none(), "{key} should not map");
        }
    }
}
