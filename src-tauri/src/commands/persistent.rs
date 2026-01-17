use serde_json::Value;

use crate::file_storage as storage;

fn basic_validate_snapshot(snapshot: &Value) -> Result<(), String> {
    // Keep validation lightweight; FE already validates.
    // We only ensure it's an object with version == 1.
    let obj = snapshot
        .as_object()
        .ok_or_else(|| "Snapshot must be a JSON object".to_string())?;

    let version = obj
        .get("version")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "Snapshot.version is required".to_string())?;

    if version != 1 {
        return Err(format!("Unsupported snapshot version: {version}"));
    }

    Ok(())
}

#[tauri::command]
pub fn persistent_load(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = storage::path_persistent_ui(&app)?;
    let value = storage::json_read_if_exists::<Value>(&path)?;

    if let Some(ref v) = value {
        basic_validate_snapshot(v)?;
    }

    Ok(value)
}

#[tauri::command]
pub fn persistent_save(app: tauri::AppHandle, snapshot: Value) -> Result<(), String> {
    basic_validate_snapshot(&snapshot)?;

    let path = storage::path_persistent_ui(&app)?;
    storage::json_write_atomic(&path, &snapshot)?;
    Ok(())
}

#[tauri::command]
pub fn persistent_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = storage::path_persistent_ui(&app)?;
    storage::remove_if_exists(&path)?;
    Ok(())
}
