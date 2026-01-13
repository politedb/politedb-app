use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, Manager};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Tauri v2: app.path().app_data_dir()
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("APP_DATA_DIR_FAILED: {e}"))?;
    dir.push("sql-drafts");
    fs::create_dir_all(&dir).map_err(|e| format!("CREATE_DRAFT_DIR_FAILED: {e}"))?;
    Ok(dir)
}

fn draft_sql_path(app: &AppHandle, window_id: &str) -> Result<PathBuf, String> {
    let mut p = drafts_dir(app)?;
    p.push(format!("{window_id}.sql"));
    Ok(p)
}

fn draft_meta_path(app: &AppHandle, window_id: &str) -> Result<PathBuf, String> {
    let mut p = drafts_dir(app)?;
    p.push(format!("{window_id}.json"));
    Ok(p)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlDraftMeta {
    pub window_id: String,
    pub last_touched_at_ms: u64,
    pub size_bytes: u64,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = path.to_path_buf();
    tmp.set_extension("tmp");

    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("CREATE_TMP_FAILED: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("WRITE_TMP_FAILED: {e}"))?;
        f.sync_all().ok(); // best-effort
    }

    fs::rename(&tmp, path).map_err(|e| format!("RENAME_TMP_FAILED: {e}"))?;
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("JSON_ENCODE_FAILED: {e}"))?;
    write_atomic(path, &bytes)
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

    let sql_path = draft_sql_path(&app, &window_id)?;
    let meta_path = draft_meta_path(&app, &window_id)?;

    // Write .sql
    write_atomic(&sql_path, content.as_bytes())?;

    // Write .json meta
    let meta = SqlDraftMeta {
        window_id: window_id.clone(),
        last_touched_at_ms: now_ms(),
        size_bytes: content.as_bytes().len() as u64,
    };
    write_json_atomic(&meta_path, &meta)?;

    Ok(())
}

/// Load draft content for a window id.
/// Returns None if draft doesn't exist.
#[command]
pub async fn sql_draft_load(app: AppHandle, window_id: String) -> Result<Option<String>, String> {
    if window_id.trim().is_empty() {
        return Err("WINDOW_ID_REQUIRED".into());
    }

    let sql_path = draft_sql_path(&app, &window_id)?;
    if !sql_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&sql_path).map_err(|e| format!("READ_DRAFT_FAILED: {e}"))?;
    Ok(Some(content))
}

/// Clear draft for a window id.
/// Called when the SQL window/tab is closed or user discards draft.
#[command]
pub async fn sql_draft_clear(app: AppHandle, window_id: String) -> Result<(), String> {
    if window_id.trim().is_empty() {
        return Err("WINDOW_ID_REQUIRED".into());
    }

    let sql_path = draft_sql_path(&app, &window_id)?;
    let meta_path = draft_meta_path(&app, &window_id)?;

    let _ = fs::remove_file(sql_path);
    let _ = fs::remove_file(meta_path);

    Ok(())
}

/// Garbage collect old drafts.
/// ttl_days: delete drafts not touched for N days.
/// max_files: keep at most N newest drafts (optional, 0 = no limit).
#[command]
pub async fn sql_draft_gc(
    app: AppHandle,
    ttl_days: u64,
    max_files: u64,
) -> Result<SqlDraftGcResult, String> {
    let dir = drafts_dir(&app)?;
    let now = now_ms();
    let ttl_ms = ttl_days.saturating_mul(24 * 60 * 60 * 1000);

    // Read all meta files
    let mut metas: Vec<SqlDraftMeta> = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| format!("READ_DIR_FAILED: {e}"))?;
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }

        match fs::read_to_string(&path) {
            Ok(s) => {
                if let Ok(m) = serde_json::from_str::<SqlDraftMeta>(&s) {
                    metas.push(m);
                }
            }
            Err(_) => {
                // ignore broken meta file
            }
        }
    }

    // Sort newest first
    metas.sort_by_key(|m| std::cmp::Reverse(m.last_touched_at_ms));

    let mut deleted: u64 = 0;
    let mut kept: u64 = 0;

    // Decide which to keep by max_files first
    let mut keep_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    if max_files > 0 {
        for (i, m) in metas.iter().enumerate() {
            if (i as u64) < max_files {
                keep_set.insert(m.window_id.clone());
            }
        }
    }

    for m in metas {
        let too_old = ttl_ms > 0 && now.saturating_sub(m.last_touched_at_ms) > ttl_ms;
        let over_limit = max_files > 0 && !keep_set.contains(&m.window_id);

        // If over limit OR too old -> delete
        if too_old || over_limit {
            let _ = sql_draft_clear(app.clone(), m.window_id.clone()).await;
            deleted += 1;
        } else {
            kept += 1;
        }
    }

    Ok(SqlDraftGcResult { deleted, kept })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlDraftGcResult {
    pub deleted: u64,
    pub kept: u64,
}
