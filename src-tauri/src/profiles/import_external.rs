use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::profiles::import_dbeaver;
use crate::profiles::import_env;
use crate::profiles::import_tableplus;
use crate::profiles::store as profile_store;
use crate::profiles::types::ConnectionProfile;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalImportSource {
    Dbeaver,
    Env,
    Tableplus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalImportResult {
    pub source: ExternalImportSource,
    pub created: usize,
    pub updated: usize,
    pub total: usize,
    pub skipped: usize,
    pub skipped_reasons: Vec<String>,
    pub passwords_included: bool,
    pub profiles: Vec<ConnectionProfile>,
}

pub fn import_external_file(
    app: &tauri::AppHandle,
    path: &str,
    password: Option<&str>,
) -> Result<ExternalImportResult, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("IMPORT_PATH_EMPTY".into());
    }

    let bytes = std::fs::read(path).map_err(|e| format!("IMPORT_READ_FAILED: {e}"))?;
    let format = detect_format(Path::new(path), &bytes)?;

    let (source, profiles, skipped, passwords_included) = match format {
        ExternalFormat::Dbeaver => {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| "DBEAVER_JSON_INVALID: file must be UTF-8 JSON".to_string())?;
            let report = import_dbeaver::parse_dbeaver_json(text)?;
            (
                ExternalImportSource::Dbeaver,
                report.profiles,
                report.skipped,
                false,
            )
        }
        ExternalFormat::TablePlus => {
            let report = import_tableplus::parse_tableplus_bytes(&bytes, password)?;
            (
                ExternalImportSource::Tableplus,
                report.profiles,
                report.skipped,
                report.passwords_included,
            )
        }
        ExternalFormat::Env => {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| "ENV_FILE_INVALID: file must be UTF-8 text".to_string())?;
            let report = import_env::parse_env(text)?;
            (
                ExternalImportSource::Env,
                report.profiles,
                report.skipped,
                report.passwords_included,
            )
        }
    };

    let (created, updated, profiles) = profile_store::profile_upsert_many(app, profiles)?;

    Ok(ExternalImportResult {
        source,
        created,
        updated,
        total: profiles.len(),
        skipped: skipped.len(),
        skipped_reasons: skipped,
        passwords_included,
        profiles,
    })
}

enum ExternalFormat {
    Dbeaver,
    Env,
    TablePlus,
}

fn detect_format(path: &Path, bytes: &[u8]) -> Result<ExternalFormat, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name == ".env" || file_name.starts_with(".env.") || ext.as_deref() == Some("env") {
        return Ok(ExternalFormat::Env);
    }

    if ext.as_deref() == Some("tableplusconnection")
        || (bytes.len() >= 2 && bytes[0] == 0x03 && bytes[1] == 0x01)
    {
        return Ok(ExternalFormat::TablePlus);
    }

    if ext.as_deref() == Some("plist") || bytes.starts_with(b"bplist") {
        return Ok(ExternalFormat::TablePlus);
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        let trimmed = text.trim();
        if trimmed.starts_with('[') {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if value
                    .as_array()
                    .and_then(|arr| arr.first())
                    .map(|item| {
                        item.get("ConnectionName").is_some() || item.get("Driver").is_some()
                    })
                    .unwrap_or(false)
                {
                    return Ok(ExternalFormat::TablePlus);
                }
            }
        }

        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if value
                .get("connections")
                .and_then(|v| v.as_object())
                .is_some()
            {
                return Ok(ExternalFormat::Dbeaver);
            }
            if value
                .get("format")
                .and_then(|v| v.as_str())
                .map(|f| f.starts_with("politedb"))
                .unwrap_or(false)
            {
                return Err(
                    "Use PoliteDB import for .politedbconnection files (Import from main menu)."
                        .into(),
                );
            }
        }
    }

    if ext.as_deref() == Some("json") {
        if let Ok(text) = std::str::from_utf8(bytes) {
            if text.contains("\"connections\"") && text.contains("\"provider\"") {
                return Ok(ExternalFormat::Dbeaver);
            }
        }
    }

    Err(
        "Unrecognized import file. Use a .env file, DBeaver data-sources.json, TablePlus .tableplusconnection / Connections.plist, or PoliteDB .politedbconnection."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dbeaver_by_extension_and_content() {
        let json =
            br#"{"connections":{"a":{"provider":"postgresql","name":"x","configuration":{}}}}"#;
        let fmt = detect_format(Path::new("/tmp/data-sources.json"), json).unwrap();
        assert!(matches!(fmt, ExternalFormat::Dbeaver));
    }

    #[test]
    fn detects_env_files() {
        let fmt = detect_format(
            Path::new("/tmp/.env.local"),
            b"DATABASE_URL=postgres://localhost/app",
        )
        .unwrap();
        assert!(matches!(fmt, ExternalFormat::Env));
    }
}
