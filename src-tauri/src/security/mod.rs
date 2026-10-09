// Profile-credential mapping is only wired on macOS; other platforms keep the
// keyring naming unchanged and use these modules in tests only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod credential_identity;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod credential_store;
pub mod keychain_macos;
pub mod secrets;
