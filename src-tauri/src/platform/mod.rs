//! Platform-native services used instead of spawning system tools.

#[cfg(target_os = "macos")]
pub mod macos;
