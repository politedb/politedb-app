use tauri::State;
use uuid::Uuid;

use crate::engines::google_sheets::api::{
    fetch_metadata, fetch_overview, fetch_rows, GoogleSheetOverview, GoogleSheetRows,
    GoogleSheetsMetadata,
};
use crate::engines::EngineConnection;
use crate::state::AppState;

fn google_sheets_connection(
    state: &AppState,
    connection_id: Uuid,
) -> Result<crate::engines::google_sheets::connection::GoogleSheetsConn, String> {
    let connection = state
        .connections
        .get(&connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?;
    match connection.value() {
        EngineConnection::GoogleSheets(connection) => Ok(connection.clone()),
        _ => Err("ENGINE_NOT_SUPPORTED".into()),
    }
}

#[tauri::command]
pub async fn google_sheets_list_sheets(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<GoogleSheetsMetadata, String> {
    let connection = google_sheets_connection(&state, connection_id)?;
    fetch_metadata(
        &connection.http,
        &connection.spreadsheet_id,
        &connection.credential,
    )
    .await
}

#[tauri::command]
pub async fn google_sheets_sheet_overview(
    state: State<'_, AppState>,
    connection_id: Uuid,
    sheet: String,
) -> Result<GoogleSheetOverview, String> {
    let connection = google_sheets_connection(&state, connection_id)?;
    let metadata = fetch_metadata(
        &connection.http,
        &connection.spreadsheet_id,
        &connection.credential,
    )
    .await?;
    let sheet_info = metadata
        .sheets
        .iter()
        .find(|item| item.title == sheet)
        .ok_or("GOOGLE_SHEETS_WORKSHEET_NOT_FOUND")?;
    fetch_overview(
        &connection.http,
        &connection.spreadsheet_id,
        &connection.credential,
        &sheet,
        sheet_info.row_count,
        sheet_info.column_count,
    )
    .await
}

#[tauri::command]
pub async fn google_sheets_fetch_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    sheet: String,
    limit: usize,
    offset: usize,
) -> Result<GoogleSheetRows, String> {
    let connection = google_sheets_connection(&state, connection_id)?;
    fetch_rows(
        &connection.http,
        &connection.spreadsheet_id,
        &connection.credential,
        &sheet,
        limit.clamp(1, 1_000),
        offset,
    )
    .await
}
