use std::sync::Arc;

use uuid::Uuid;

#[derive(Clone)]
pub struct GoogleSheetsConn {
    pub id: Uuid,
    pub label: String,
    pub spreadsheet_id: String,
    pub credential: String,
    pub http: Arc<reqwest::Client>,
}
