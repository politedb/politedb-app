#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}
