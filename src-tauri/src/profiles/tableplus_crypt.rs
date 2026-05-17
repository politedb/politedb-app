//! TablePlus `.tableplusconnection` files use RNCryptor v3 (password-based AES-256-CBC).

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use cbc::Decryptor;
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2;
use sha1::Sha1;
use sha2::Sha256;

type Aes256CbcDec = Decryptor<aes::Aes256>;

const HEADER_LEN: usize = 1 + 1 + 8 + 8 + 16;
const HMAC_LEN: usize = 32;
const PBKDF2_ITERATIONS: u32 = 10_000;

pub fn decrypt_tableplus_export(bytes: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if bytes.len() < HEADER_LEN + HMAC_LEN + 16 {
        return Err("TABLEPLUS_DECRYPT_FAILED: file too short".into());
    }
    if bytes[0] != 0x03 {
        return Err("TABLEPLUS_DECRYPT_FAILED: unsupported RNCryptor version".into());
    }

    let options = bytes[1];
    if options & 0x01 == 0 {
        return Err("TABLEPLUS_DECRYPT_FAILED: expected password-based encryption".into());
    }

    let enc_salt = &bytes[2..10];
    let hmac_salt = &bytes[10..18];
    let iv = &bytes[18..34];
    let hmac_start = bytes.len() - HMAC_LEN;
    let ciphertext = &bytes[34..hmac_start];
    let hmac_bytes = &bytes[hmac_start..];

    let enc_key = derive_key(password, enc_salt)?;
    let hmac_key = derive_key(password, hmac_salt)?;

    let mut mac = Hmac::<Sha256>::new_from_slice(&hmac_key)
        .map_err(|_| "TABLEPLUS_DECRYPT_FAILED: invalid HMAC key".to_string())?;
    Mac::update(&mut mac, &bytes[..hmac_start]);
    mac.verify_slice(hmac_bytes).map_err(|_| {
        "TABLEPLUS_DECRYPT_FAILED: wrong file password or corrupted export".to_string()
    })?;

    let cipher = Aes256CbcDec::new_from_slices(&enc_key, iv)
        .map_err(|_| "TABLEPLUS_DECRYPT_FAILED: invalid key/IV".to_string())?;

    cipher
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|_| "TABLEPLUS_DECRYPT_FAILED: decryption failed".to_string())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    pbkdf2::<Hmac<Sha1>>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key)
        .map_err(|_| "TABLEPLUS_DECRYPT_FAILED: key derivation failed".to_string())?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_blob() {
        let err = decrypt_tableplus_export(&[3, 1], "pw").unwrap_err();
        assert!(err.contains("too short"));
    }
}
