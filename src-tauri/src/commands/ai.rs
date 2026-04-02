use tauri::AppHandle;

use crate::{ai_runtime, state::AppState};

#[tauri::command]
pub async fn ai_runtime_status(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<ai_runtime::AiRuntimeStatus, String> {
    Ok(ai_runtime::ai_runtime_status(&app, &state).await)
}

#[tauri::command]
pub async fn ai_runtime_start(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<ai_runtime::AiRuntimeStatus, String> {
    ai_runtime::ai_runtime_start(&app, &state).await
}

#[tauri::command]
pub async fn ai_runtime_stop(state: tauri::State<'_, AppState>) -> Result<ai_runtime::AiRuntimeStatus, String> {
    ai_runtime::ai_runtime_stop(&state).await
}

#[tauri::command]
pub async fn ai_runtime_download_default_model(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<ai_runtime::AiRuntimeStatus, String> {
    ai_runtime::ai_runtime_download_default_model(&app, &state).await
}
