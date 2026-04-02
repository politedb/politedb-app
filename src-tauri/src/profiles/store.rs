use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::profiles::types::ConnectionProfile;
use crate::types::ConnectionCreateInput;

use crate::file_storage as storage;

const PROFILE_VERSION: u32 = 1;

pub fn profile_file_version() -> u32 {
    PROFILE_VERSION
}

/* ============================================================================
 * File format
 * ============================================================================
 */

#[derive(Debug, Serialize, Deserialize)]
struct ProfileFile {
    version: u32,
    profiles: Vec<ConnectionProfile>,
}

/* ============================================================================
 * Helpers
 * ============================================================================
 */

fn now_epoch_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_profiles(app: &AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    let path = storage::path_profiles(app)?;

    let raw_opt = storage::text_read_if_exists(&path)?;
    let Some(raw) = raw_opt else {
        return Ok(Vec::new());
    };

    let file: ProfileFile =
        serde_json::from_str(&raw).map_err(|e| format!("PROFILE_JSON_INVALID: {e}"))?;

    if file.version != PROFILE_VERSION {
        return Err(format!(
            "PROFILE_VERSION_MISMATCH: expected {}, got {}",
            PROFILE_VERSION, file.version
        ));
    }

    Ok(file.profiles)
}

fn save_profiles(app: &AppHandle, profiles: &[ConnectionProfile]) -> Result<(), String> {
    let path = storage::path_profiles(app)?;

    let file = ProfileFile {
        version: PROFILE_VERSION,
        profiles: profiles.to_vec(),
    };

    // Keep pretty JSON (same behavior as current code)
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("PROFILE_SERIALIZE_FAILED: {e}"))?;

    storage::text_write_atomic(&path, &json)?;
    Ok(())
}

/* ============================================================================
 * Public API (used by commands)
 * ============================================================================
 */

pub fn profile_list(app: &AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    load_profiles(app)
}

pub fn profile_get(app: &AppHandle, profile_id: Uuid) -> Result<ConnectionProfile, String> {
    let profiles = load_profiles(app)?;
    profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "PROFILE_NOT_FOUND".to_string())
}

pub fn profile_update(
    app: &AppHandle,
    profile_id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    let mut profiles = load_profiles(app)?;
    let now = now_epoch_sec();

    let p = profiles
        .iter_mut()
        .find(|p| p.id == profile_id)
        .ok_or("PROFILE_NOT_FOUND")?;

    p.engine = input.engine.clone();
    p.label = input.label.clone();
    p.input = input;
    p.updated_at = now;

    let updated = p.clone();
    save_profiles(app, &profiles)?;
    Ok(updated)
}

pub fn profile_remove(app: &AppHandle, profile_id: Uuid) -> Result<(), String> {
    let mut profiles = load_profiles(app)?;
    let before = profiles.len();

    profiles.retain(|p| p.id != profile_id);

    if profiles.len() == before {
        return Err("PROFILE_NOT_FOUND".into());
    }

    save_profiles(app, &profiles)?;
    Ok(())
}

pub fn profile_upsert_many(
    app: &AppHandle,
    incoming: Vec<ConnectionProfile>,
) -> Result<(usize, usize, Vec<ConnectionProfile>), String> {
    let current = load_profiles(app)?;
    let mut by_id: BTreeMap<Uuid, ConnectionProfile> =
        current.into_iter().map(|p| (p.id, p)).collect();

    let mut created = 0usize;
    let mut updated = 0usize;

    for profile in incoming {
        if by_id.insert(profile.id, profile).is_some() {
            updated += 1;
        } else {
            created += 1;
        }
    }

    let profiles: Vec<ConnectionProfile> = by_id.into_values().collect();
    save_profiles(app, &profiles)?;
    Ok((created, updated, profiles))
}

pub fn profile_create_with_id(
    app: &AppHandle,
    id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    let mut profiles = load_profiles(app)?;
    let now = now_epoch_sec();

    let profile = ConnectionProfile {
        id,
        engine: input.engine.clone(),
        label: input.label.clone(),
        tags: input.tags.clone(),
        indicator_color: input.indicator_color.clone(),
        input,
        created_at: now,
        updated_at: now,
    };

    profiles.push(profile.clone());
    save_profiles(app, &profiles)?;
    Ok(profile)
}
