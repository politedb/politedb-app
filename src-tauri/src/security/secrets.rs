use anyhow::Context;

const KEYCHAIN_SERVICE: &str = "politedb";

pub fn keychain_set(key: &str, secret: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)?;
    entry
        .set_password(secret)
        .context("keychain_set_password failed")?;
    Ok(())
}

pub fn keychain_get(key: &str) -> anyhow::Result<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)?;
    let pw = entry
        .get_password()
        .context("keychain_get_password failed")?;
    Ok(pw)
}

pub fn keychain_delete(key: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)?;
    let _ = entry.delete_password();
    Ok(())
}
