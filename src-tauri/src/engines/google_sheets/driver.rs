use std::sync::Arc;

use async_trait::async_trait;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::google_sheets::api::{fetch_metadata, normalize_spreadsheet_id};
use crate::engines::google_sheets::connection::GoogleSheetsConn;
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::EngineConnection;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, GoogleSheetsConnectInput,
    SecretRefKind,
};

pub struct GoogleSheetsDriver;

#[async_trait]
impl EngineDriver for GoogleSheetsDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::GoogleSheets
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let sheets = input.google_sheets.ok_or("GOOGLE_SHEETS_CONFIG_MISSING")?;
        let spreadsheet_id = normalize_spreadsheet_id(&sheets.spreadsheet_id)?;
        let credential = resolve_secret_ref(app, &sheets.credential).await?;
        let http = make_http_client()?;
        fetch_metadata(&http, &spreadsheet_id, &credential).await?;

        Ok(EngineConnection::GoogleSheets(GoogleSheetsConn {
            id: conn_id,
            label,
            spreadsheet_id,
            credential,
            http: Arc::new(http),
        }))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let sheets = input.google_sheets.ok_or("GOOGLE_SHEETS_CONFIG_MISSING")?;
        let spreadsheet_id = normalize_spreadsheet_id(&sheets.spreadsheet_id)?;
        let credential = resolve_secret_ref_for_test(
            app,
            &sheets.credential,
            secrets
                .as_ref()
                .and_then(|value| value.db_password.as_deref()),
        )
        .await?;
        fetch_metadata(&make_http_client()?, &spreadsheet_id, &credential)
            .await
            .map(|_| ())
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        override_input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        let current = base
            .google_sheets
            .as_mut()
            .ok_or("GOOGLE_SHEETS_CONFIG_MISSING")?;
        if let Some(override_sheets) = override_input.google_sheets {
            if !override_sheets.spreadsheet_id.trim().is_empty() {
                current.spreadsheet_id = override_sheets.spreadsheet_id;
            }
            if override_sheets.credential.kind == SecretRefKind::Inline
                && !override_sheets.credential.value.trim().is_empty()
            {
                current.credential = override_sheets.credential;
            }
        }
        if let Some(secret) = secrets
            .and_then(|value| value.db_password)
            .filter(|value| !value.trim().is_empty())
        {
            current.credential.kind = SecretRefKind::Inline;
            current.credential.value = secret;
        }
        Ok(base)
    }

    fn persist_profile_secrets(
        &self,
        app: &AppHandle,
        profile_id: Uuid,
        persist_secrets: bool,
        mut input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        let sheets = input
            .google_sheets
            .as_mut()
            .ok_or("GOOGLE_SHEETS_CONFIG_MISSING")?;
        crate::engines::profile_secrets::persist_secret_ref(
            app,
            profile_id,
            EngineKind::GoogleSheets,
            persist_secrets,
            &mut sheets.credential,
        )?;
        Ok(input)
    }
}

fn make_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "GOOGLE_SHEETS_HTTP_CLIENT_FAILED".to_string())
}

#[allow(dead_code)]
fn _assert_input_type(_: GoogleSheetsConnectInput) {}
