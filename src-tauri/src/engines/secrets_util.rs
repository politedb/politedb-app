use tauri::AppHandle;

use crate::security::secrets;
use crate::types::{SecretRef, SecretRefKind};

/// Resolve SecretRef (inline/keychain) for CONNECT path.
pub async fn resolve_secret_ref(app: &AppHandle, secret: &SecretRef) -> Result<String, String> {
    match secret.kind {
        SecretRefKind::Inline => {
            let v = secret.value.clone();
            if v.is_empty() {
                return Err("EMPTY_INLINE_SECRET".into());
            }
            Ok(v)
        }

        SecretRefKind::Keychain => {
            let key = secret.value.trim();
            if key.is_empty() {
                return Err("EMPTY_KEYCHAIN_KEY".into());
            }

            // IMPORTANT:
            // - Do NOT leak secret value
            // - But include key in errors so FE can prompt user correctly
            let v = match secrets::keychain_get(app, key) {
                Ok(v) => v,
                Err(e) => {
                    // Normalize common case for better UX & debugging
                    if e == "KEYCHAIN_ITEM_NOT_FOUND" {
                        return Err("CREDENTIALS_INVALID".into());
                    }
                    return Err(e);
                }
            };

            if v.is_empty() {
                return Err("CREDENTIALS_INVALID".into());
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
