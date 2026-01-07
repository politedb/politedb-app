use tauri::AppHandle;

use crate::security::secrets;
use crate::types::{SecretRef, SecretRefKind};

/// Resolve SecretRef (inline/keychain) for CONNECT path.
pub async fn resolve_secret_ref(app: &AppHandle, secret: &SecretRef) -> Result<String, String> {
    match secret.kind {
        SecretRefKind::Inline => Ok(secret.value.clone()),
        SecretRefKind::Keychain => {
            let key = secret.value.trim();
            if key.is_empty() {
                return Err("EMPTY_KEYCHAIN_KEY".into());
            }

            let v = secrets::keychain_get(app, key).map_err(|e| e.to_string())?;
            if v.is_empty() {
                return Err("EMPTY_SECRET_FROM_KEYCHAIN".into());
            }

            Ok(v)
        }
    }
}

/// TEST policy:
/// - if override_plain is Some(non-empty) => use it
/// - else => resolve from secret_ref (inline/keychain)
pub async fn resolve_secret_ref_for_test(
    app: &AppHandle,
    secret_ref: &SecretRef,
    override_plain: Option<&str>,
) -> Result<String, String> {
    if let Some(pw) = override_plain.map(str::trim) {
        if !pw.is_empty() {
            return Ok(pw.to_string());
        }
    }
    resolve_secret_ref(app, secret_ref).await
}
