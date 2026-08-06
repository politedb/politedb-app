use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngExt;
use serde::{Deserialize, Serialize};

pub const EXPORT_FORMAT: &str = "politedb_encrypted_export_v1";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const SALT_LEN: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedExportFile {
    pub format: String,
    pub kdf: String,
    pub cipher: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub fn is_encrypted_export(json: &str) -> bool {
    serde_json::from_str::<EncryptedExportFile>(json)
        .map(|file| file.format == EXPORT_FORMAT)
        .unwrap_or(false)
}

pub fn encrypt_export_payload(plaintext: &str, password: &str) -> Result<String, String> {
    validate_password(password)?;

    let mut salt = [0u8; SALT_LEN];
    rand::rng().fill(&mut salt);

    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("EXPORT_CIPHER_INIT: {e}"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("EXPORT_ENCRYPT_FAILED: {e}"))?;

    let envelope = EncryptedExportFile {
        format: EXPORT_FORMAT.into(),
        kdf: "argon2id".into(),
        cipher: "aes-256-gcm".into(),
        salt: B64.encode(salt),
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(ciphertext),
    };

    serde_json::to_string_pretty(&envelope)
        .map_err(|e| format!("EXPORT_ENCRYPT_SERIALIZE: {e}"))
}

pub fn decrypt_export_payload(json: &str, password: &str) -> Result<String, String> {
    validate_password(password)?;

    let envelope: EncryptedExportFile =
        serde_json::from_str(json).map_err(|e| format!("EXPORT_DECRYPT_INVALID_JSON: {e}"))?;

    if envelope.format != EXPORT_FORMAT {
        return Err("EXPORT_DECRYPT_UNSUPPORTED_FORMAT".into());
    }

    let salt = B64
        .decode(envelope.salt.trim())
        .map_err(|e| format!("EXPORT_DECRYPT_INVALID_SALT: {e}"))?;
    let nonce_bytes = B64
        .decode(envelope.nonce.trim())
        .map_err(|e| format!("EXPORT_DECRYPT_INVALID_NONCE: {e}"))?;
    let ciphertext = B64
        .decode(envelope.ciphertext.trim())
        .map_err(|e| format!("EXPORT_DECRYPT_INVALID_CIPHERTEXT: {e}"))?;

    if nonce_bytes.len() != NONCE_LEN {
        return Err("EXPORT_DECRYPT_INVALID_NONCE".into());
    }

    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("EXPORT_CIPHER_INIT: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "EXPORT_DECRYPT_WRONG_PASSWORD".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("EXPORT_DECRYPT_INVALID_UTF8: {e}"))
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("EXPORT_PASSWORD_REQUIRED".into());
    }
    Ok(())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let params = Params::new(19_456, 2, 1, Some(KEY_LEN))
        .map_err(|e| format!("EXPORT_KDF_PARAMS: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("EXPORT_KDF_FAILED: {e}"))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let plain = r#"{"version":1,"profiles":[]}"#;
        let encrypted = encrypt_export_payload(plain, "test-password-123").unwrap();
        assert!(is_encrypted_export(&encrypted));
        let out = decrypt_export_payload(&encrypted, "test-password-123").unwrap();
        assert_eq!(out, plain);
    }

    #[test]
    fn wrong_password_fails() {
        let encrypted =
            encrypt_export_payload("secret payload", "correct-password-12").unwrap();
        let err = decrypt_export_payload(&encrypted, "wrong-password-12").unwrap_err();
        assert!(err.contains("WRONG_PASSWORD"));
    }
}
