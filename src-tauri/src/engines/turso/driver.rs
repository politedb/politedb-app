use async_trait::async_trait;
use libsql::Builder;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::merge_secret_ref_for_test;
use crate::engines::secrets_util::{resolve_secret_ref, resolve_secret_ref_for_test};
use crate::engines::turso::connection::TursoConn;
use crate::engines::EngineConnection;
use crate::types::{ConnectionCreateInput, ConnectionTestSecrets, EngineKind, TursoConnectInput};

pub struct TursoDriver;

#[async_trait]
impl EngineDriver for TursoDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Turso
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let turso = input.turso.ok_or("TURSO_CONFIG_MISSING")?;
        let conn = connect_turso(app, conn_id, label, turso).await?;
        Ok(EngineConnection::Turso(conn))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let turso = input.turso.ok_or("TURSO_CONFIG_MISSING")?;
        test_turso(app, turso, secrets).await
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        let mut b = base.turso.ok_or("TURSO_CONFIG_MISSING")?;

        if let Some(ov_turso) = ov.turso {
            if !ov_turso.url.trim().is_empty() {
                b.url = ov_turso.url;
            }
            if ov_turso.statement_timeout_ms.is_some() {
                b.statement_timeout_ms = ov_turso.statement_timeout_ms;
            }
            merge_secret_ref_for_test(
                &mut b.auth_token,
                &ov_turso.auth_token,
                secrets
                    .as_ref()
                    .and_then(|s| s.db_password.as_ref())
                    .filter(|s| !s.trim().is_empty()),
            );
        }

        base.turso = Some(b);
        Ok(base)
    }
    fn persist_profile_secrets(
        &self,
        app: &AppHandle,
        profile_id: uuid::Uuid,
        persist_secrets: bool,
        mut input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        let turso = input.turso.as_mut().ok_or("TURSO_CONFIG_MISSING")?;
        crate::engines::profile_secrets::persist_secret_ref(
            app,
            profile_id,
            EngineKind::Turso,
            persist_secrets,
            &mut turso.auth_token,
        )?;
        Ok(input)
    }
}

/// Normalize user input to an HTTPS libSQL/Hrana endpoint (same rules as the libsql SDK).
pub fn normalize_turso_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("TURSO_URL_REQUIRED".into());
    }

    let lower = url.to_ascii_lowercase();
    if lower.starts_with("file:") {
        return Err(
            "TURSO_URL_INVALID: use a remote libsql/https URL, not a local file path".into(),
        );
    }

    let is_local_dev =
        lower.contains("localhost") || lower.contains("127.0.0.1") || lower.contains("[::1]");

    let mut normalized = if lower.starts_with("libsql://") {
        url.replacen("libsql://", "https://", 1)
    } else if lower.starts_with("https://") {
        url.to_string()
    } else if lower.starts_with("http://") {
        url.to_string()
    } else if url.contains("://") {
        return Err(format!(
            "TURSO_URL_INVALID: unsupported URL scheme (use libsql://, https://, or http:// for local dev)"
        ));
    } else {
        format!("https://{url}")
    };

    let norm_lower = normalized.to_ascii_lowercase();
    // Turso Cloud only serves HTTPS; http://*.turso.io:80 → connection refused (os error 61).
    if !is_local_dev && norm_lower.starts_with("http://") {
        normalized = normalized.replacen("http://", "https://", 1);
    }

    if !normalized.contains("://") {
        return Err("TURSO_URL_INVALID".into());
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::normalize_turso_url;

    #[test]
    fn host_only_gets_https() {
        assert_eq!(
            normalize_turso_url("my-db-myorg.turso.io").unwrap(),
            "https://my-db-myorg.turso.io"
        );
    }

    #[test]
    fn libsql_scheme_becomes_https() {
        assert_eq!(
            normalize_turso_url("libsql://my-db-myorg.turso.io").unwrap(),
            "https://my-db-myorg.turso.io"
        );
    }

    #[test]
    fn cloud_http_upgraded_to_https() {
        assert_eq!(
            normalize_turso_url("http://my-db-myorg.turso.io").unwrap(),
            "https://my-db-myorg.turso.io"
        );
    }

    #[test]
    fn local_http_stays_http() {
        assert_eq!(
            normalize_turso_url("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
    }
}

fn turso_test_error(url: &str, err: &impl std::fmt::Display) -> String {
    let msg = err.to_string();
    let hint = if msg.contains("Connection refused") || msg.contains("connection refused") {
        if url.contains("127.0.0.1") || url.contains("localhost") {
            " Hint: is `turso dev` running on that host/port?"
        } else if url.starts_with("http://") {
            " Hint: Turso Cloud requires https://, not http://."
        } else {
            " Hint: check the database URL from `turso db show` and that the auth token is valid."
        }
    } else {
        ""
    };
    format!("TURSO_TEST_FAILED ({url}): {msg}{hint}")
}

async fn build_remote_db(url: &str, auth_token: &str) -> Result<libsql::Database, String> {
    Builder::new_remote(url.to_string(), auth_token.to_string())
        .build()
        .await
        .map_err(|e| format!("TURSO_BUILD_FAILED: {e}"))
}

pub async fn connect_turso(
    app: &AppHandle,
    conn_id: Uuid,
    label: String,
    input: TursoConnectInput,
) -> Result<TursoConn, String> {
    let url = normalize_turso_url(&input.url)?;
    let auth_token = resolve_secret_ref(app, &input.auth_token).await?;

    let db = build_remote_db(&url, &auth_token).await?;
    let conn = db
        .connect()
        .map_err(|e| format!("TURSO_CONNECT_FAILED: {e}"))?;
    conn.query("SELECT 1", ())
        .await
        .map_err(|e| format!("TURSO_SMOKE_TEST_FAILED ({url}): {e}"))?;

    Ok(TursoConn {
        id: conn_id,
        label,
        db: std::sync::Arc::new(db),
        default_statement_timeout_ms: input.statement_timeout_ms,
    })
}

pub async fn test_turso(
    app: &AppHandle,
    input: TursoConnectInput,
    secrets: Option<ConnectionTestSecrets>,
) -> Result<(), String> {
    let url = normalize_turso_url(&input.url)?;
    let auth_token = resolve_secret_ref_for_test(
        app,
        &input.auth_token,
        secrets.as_ref().and_then(|s| s.db_password.as_deref()),
    )
    .await?;

    let db = build_remote_db(&url, &auth_token).await?;
    let conn = db
        .connect()
        .map_err(|e| format!("TURSO_TEST_CONNECT_FAILED: {e}"))?;
    conn.query("SELECT 1", ())
        .await
        .map_err(|e| turso_test_error(&url, &e))?;

    Ok(())
}
