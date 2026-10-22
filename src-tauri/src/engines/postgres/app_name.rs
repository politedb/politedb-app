//! `application_name` for every PostgreSQL connection this process opens.
//!
//! The name carries a random tag created once per process (`PoliteDB/<8 hex>`),
//! so the Health Inspector can tell this running instance's sessions apart
//! from everyone else's (including PoliteDB on other machines) in the same
//! statement that would signal them. The tag is a public label, never
//! persisted or logged, and not derived from license or device data.

use std::sync::OnceLock;

use rand::rngs::SysRng;
use rand::TryRng;

const APP_NAME_PREFIX: &str = "PoliteDB/";

static INSTANCE_APP_NAME: OnceLock<String> = OnceLock::new();

fn format_app_name(tag: [u8; 4]) -> String {
    let hex: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    format!("{APP_NAME_PREFIX}{hex}")
}

/// This process's PostgreSQL `application_name`. Fails (and the connection
/// with it) when the OS random source is unavailable, rather than falling back
/// to a fixed or empty name that would weaken own-session protection.
pub fn postgres_app_name() -> anyhow::Result<&'static str> {
    app_name_in(&INSTANCE_APP_NAME)
}

fn app_name_in(cell: &OnceLock<String>) -> anyhow::Result<&str> {
    if let Some(name) = cell.get() {
        return Ok(name.as_str());
    }
    let mut tag = [0u8; 4];
    SysRng
        .try_fill_bytes(&mut tag)
        .map_err(|_| anyhow::anyhow!("POSTGRES_APP_NAME_UNAVAILABLE"))?;
    // A concurrent caller may have won the race; keep the first value.
    Ok(cell.get_or_init(|| format_app_name(tag)).as_str())
}

/// Read-only: lets the Inspector label "This app" rows. Not a security check;
/// the signal statement compares names on the server.
#[tauri::command]
pub fn postgres_instance_app_name() -> Result<String, String> {
    postgres_app_name()
        .map(str::to_string)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_short_printable_and_stable() {
        let first = postgres_app_name().expect("random source");
        assert!(first.starts_with(APP_NAME_PREFIX));
        let tag = &first[APP_NAME_PREFIX.len()..];
        assert_eq!(tag.len(), 8);
        assert!(tag
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // Fits PostgreSQL's 63-byte NAMEDATALEN limit without truncation.
        assert!(first.len() < 64);
        assert_eq!(postgres_app_name().unwrap(), first);
    }

    #[test]
    fn concurrent_callers_get_one_name() {
        // A fresh, empty cell: all threads race on the first initialisation.
        static CELL: OnceLock<String> = OnceLock::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    app_name_in(&CELL).unwrap().to_string()
                })
            })
            .collect();
        let names: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(names.windows(2).all(|w| w[0] == w[1]));
    }

    #[test]
    fn formats_lowercase_hex() {
        assert_eq!(
            format_app_name([0x00, 0xab, 0x10, 0xff]),
            "PoliteDB/00ab10ff"
        );
    }
}
