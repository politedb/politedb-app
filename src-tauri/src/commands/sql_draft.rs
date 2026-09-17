use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, Manager};

use crate::file_storage as storage;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn meta_path_for_sql_path(sql_path: &Path) -> PathBuf {
    // drafts/sql/<id>.sql -> drafts/sql/<id>.json
    sql_path.with_extension("json")
}

/* =============================================================================
 * Legacy migration: sql-drafts/  ->  drafts/sql/
 * ============================================================================= */

static MIGRATED: OnceLock<()> = OnceLock::new();

fn legacy_drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("APP_DATA_DIR_FAILED: {e}"))?;
    Ok(dir.join("sql-drafts"))
}

fn try_rename_or_copy_then_remove(from: &Path, to: &Path) -> Result<(), String> {
    // Ensure target parent exists
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("CREATE_DIR_FAILED: {e}"))?;
    }

    // Prefer atomic rename (same filesystem)
    match fs::rename(from, to) {
        Ok(_) => Ok(()),
        Err(_) => {
            // Fallback: copy then remove (cross-device)
            fs::copy(from, to).map_err(|e| format!("COPY_FAILED: {e}"))?;
            let _ = fs::remove_file(from);
            Ok(())
        }
    }
}

fn migrate_legacy_sql_drafts_once(app: &AppHandle) -> Result<(), String> {
    // Run at most once per process
    if MIGRATED.get().is_some() {
        return Ok(());
    }

    let legacy_dir = legacy_drafts_dir(app)?;
    if !legacy_dir.exists() {
        MIGRATED.set(()).ok();
        return Ok(());
    }

    let new_dir = storage::dir_sql_drafts(app)?;
    // Ensure new dir exists
    fs::create_dir_all(&new_dir).map_err(|e| format!("CREATE_NEW_DRAFT_DIR_FAILED: {e}"))?;

    // Move *.sql and *.json, pairing by stem.
    for entry in fs::read_dir(&legacy_dir).map_err(|e| format!("READ_LEGACY_DIR_FAILED: {e}"))? {
        let entry = entry.map_err(|e| format!("READ_LEGACY_ENTRY_FAILED: {e}"))?;
        let from = entry.path();

        let ext = from.extension().and_then(|s| s.to_str()).unwrap_or("");
        if ext != "sql" && ext != "json" {
            continue;
        }

        let file_name = match from.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let to = new_dir.join(file_name);

        // Avoid overwriting newer files in new location
        if to.exists() {
            continue;
        }

        let _ = try_rename_or_copy_then_remove(&from, &to);
    }

    // Try remove legacy dir if empty (best-effort)
    let _ = fs::remove_dir(&legacy_dir);

    MIGRATED.set(()).ok();
    Ok(())
}

/* =============================================================================
 * Types
 * ============================================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlDraftMeta {
    pub window_id: String,
    pub last_touched_at_ms: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlDraftGcResult {
    pub deleted: u64,
    pub kept: u64,
}

/* =============================================================================
 * Commands
 * ============================================================================= */

/// Save draft content for a window id.
/// Policy: called debounced from FE; should be fast and reliable.
#[command]
pub async fn sql_draft_save(
    app: AppHandle,
    window_id: String,
    content: String,
) -> Result<(), String> {
    if window_id.trim().is_empty() {
        return Err("WINDOW_ID_REQUIRED".into());
    }

    // One-time migration from legacy folder
    let _ = migrate_legacy_sql_drafts_once(&app);

    let sql_path = storage::path_sql_draft(&app, &window_id)?;
    let meta_path = meta_path_for_sql_path(&sql_path);

    storage::text_write_atomic(&sql_path, &content)?;

    let meta = SqlDraftMeta {
        window_id: window_id.clone(),
        last_touched_at_ms: now_ms(),
        size_bytes: content.len() as u64,
    };
    storage::json_write_atomic(&meta_path, &meta)?;

    Ok(())
}

/// Load draft content for a window id.
/// Returns None if draft doesn't exist.
#[command]
pub async fn sql_draft_load(app: AppHandle, window_id: String) -> Result<Option<String>, String> {
    if window_id.trim().is_empty() {
        return Err("WINDOW_ID_REQUIRED".into());
    }

    let _ = migrate_legacy_sql_drafts_once(&app);

    let sql_path = storage::path_sql_draft(&app, &window_id)?;
    storage::text_read_if_exists(&sql_path)
}

/// Clear draft for a window id.
/// Called when the SQL window/tab is closed or user discards draft.
#[command]
pub async fn sql_draft_clear(app: AppHandle, window_id: String) -> Result<(), String> {
    if window_id.trim().is_empty() {
        return Err("WINDOW_ID_REQUIRED".into());
    }

    let _ = migrate_legacy_sql_drafts_once(&app);

    let sql_path = storage::path_sql_draft(&app, &window_id)?;
    let meta_path = meta_path_for_sql_path(&sql_path);

    let _ = storage::remove_if_exists(&sql_path);
    let _ = storage::remove_if_exists(&meta_path);

    Ok(())
}

/// Garbage collect old drafts.
/// ttl_days: delete drafts not touched for N days.
/// max_files: keep at most N newest drafts (0 = no limit).
#[command]
pub async fn sql_draft_gc(
    app: AppHandle,
    ttl_days: u64,
    max_files: u64,
) -> Result<SqlDraftGcResult, String> {
    let _ = migrate_legacy_sql_drafts_once(&app);

    let dir = storage::dir_sql_drafts(&app)?;
    if !dir.exists() {
        return Ok(SqlDraftGcResult {
            deleted: 0,
            kept: 0,
        });
    }

    let now = now_ms();
    let ttl_ms = ttl_days.saturating_mul(24 * 60 * 60 * 1000);

    #[derive(Clone)]
    struct DraftEntry {
        window_id: String,
        last_touched_at_ms: u64,
    }

    let mut drafts: Vec<DraftEntry> = vec![];

    for entry in fs::read_dir(&dir).map_err(|e| format!("READ_DIR_FAILED: {e}"))? {
        let entry = entry.map_err(|e| format!("READ_DIR_ENTRY_FAILED: {e}"))?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("sql") {
            continue;
        }

        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let window_id = stem.to_string();

        let meta_path = meta_path_for_sql_path(&path);
        let touched =
            if let Ok(Some(meta)) = storage::json_read_if_exists::<SqlDraftMeta>(&meta_path) {
                meta.last_touched_at_ms
            } else {
                let modified = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH);

                modified
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or(Duration::ZERO)
                    .as_millis() as u64
            };

        drafts.push(DraftEntry {
            window_id,
            last_touched_at_ms: touched,
        });
    }

    // Sort newest first
    drafts.sort_by_key(|d| std::cmp::Reverse(d.last_touched_at_ms));

    // Keep set by max_files
    let mut keep_set: HashSet<String> = HashSet::new();
    if max_files > 0 {
        for (i, d) in drafts.iter().enumerate() {
            if (i as u64) < max_files {
                keep_set.insert(d.window_id.clone());
            }
        }
    }

    let mut deleted: u64 = 0;
    let mut kept: u64 = 0;

    for d in drafts {
        let too_old = ttl_ms > 0 && now.saturating_sub(d.last_touched_at_ms) > ttl_ms;
        let over_limit = max_files > 0 && !keep_set.contains(&d.window_id);

        if too_old || over_limit {
            let sql_path = storage::path_sql_draft(&app, &d.window_id)?;
            let meta_path = meta_path_for_sql_path(&sql_path);

            let _ = storage::remove_if_exists(&sql_path);
            let _ = storage::remove_if_exists(&meta_path);

            deleted += 1;
        } else {
            kept += 1;
        }
    }

    Ok(SqlDraftGcResult { deleted, kept })
}
