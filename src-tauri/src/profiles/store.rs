use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::profiles::types::ConnectionProfile;
use crate::types::ConnectionCreateInput;

const PROFILE_DIR: &str = "profiles";
const PROFILE_FILE: &str = "profiles.json";
const PROFILE_VERSION: u32 = 1;

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

fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("APP_DATA_DIR_NOT_AVAILABLE: {e}"))?
        .join(PROFILE_DIR);

    fs::create_dir_all(&dir).map_err(|e| format!("CREATE_PROFILE_DIR_FAILED: {e}"))?;
    Ok(dir)
}

fn profile_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_dir(app)?.join(PROFILE_FILE))
}

fn load_profiles(app: &AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    let path = profile_file_path(app)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path).map_err(|e| format!("READ_PROFILE_FILE_FAILED: {e}"))?;

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
    let path = profile_file_path(app)?;
    let tmp = path.with_extension("json.tmp");

    let file = ProfileFile {
        version: PROFILE_VERSION,
        profiles: profiles.to_vec(),
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("PROFILE_SERIALIZE_FAILED: {e}"))?;

    // Atomic write: write temp -> rename
    fs::write(&tmp, json).map_err(|e| format!("WRITE_PROFILE_TMP_FAILED: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("ATOMIC_RENAME_FAILED: {e}"))?;

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
